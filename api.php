<?php
// One small storage box in the database, shared by everyone who has the link + key.
// GET returns what's saved. POST saves a new copy, but refuses to save if someone else
// has saved a newer copy since you last loaded (so two people editing around the same
// time can't silently erase each other's work).
header('Content-Type: application/json; charset=utf-8');

require __DIR__ . '/db.php';
$cfg = require __DIR__ . '/config.php';

$key = $_GET['key'] ?? '';
if (!hash_equals((string) $cfg['access_key'], (string) $key)) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'Wrong or missing key.']);
    exit;
}
if (strpos($cfg['access_key'], 'REPLACE_WITH') === 0) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'This server has not been set up yet: edit config.php first.']);
    exit;
}

try {
    $pdo = get_pdo();
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Could not connect to the database. Check config.php.']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $row = $pdo->query('SELECT data, updated_at FROM app_state WHERE id = 1')->fetch();
    echo json_encode([
        'ok' => true,
        'data' => $row ? json_decode($row['data']) : null,
        'updatedAt' => $row ? $row['updated_at'] : null,
    ]);
    exit;
}

if ($method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body) || !array_key_exists('state', $body)) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Invalid request.']);
        exit;
    }
    $stateJson = json_encode($body['state']);
    $base = $body['baseUpdatedAt'] ?? null;
    $now = date('Y-m-d H:i:s');

    $row = $pdo->query('SELECT updated_at FROM app_state WHERE id = 1')->fetch();

    if (!$row) {
        // Nothing saved yet anywhere - this is the very first save, it always succeeds.
        $pdo->prepare('INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, ?)')->execute([$stateJson, $now]);
        echo json_encode(['ok' => true, 'updatedAt' => $now]);
        exit;
    }

    if ($base === null || $base !== $row['updated_at']) {
        http_response_code(409);
        echo json_encode(['ok' => false, 'error' => 'conflict', 'updatedAt' => $row['updated_at']]);
        exit;
    }

    $stmt = $pdo->prepare('UPDATE app_state SET data = ?, updated_at = ? WHERE id = 1 AND updated_at = ?');
    $stmt->execute([$stateJson, $now, $base]);
    if ($stmt->rowCount() === 0) {
        // Someone else saved in the instant between our check above and this update.
        $row2 = $pdo->query('SELECT updated_at FROM app_state WHERE id = 1')->fetch();
        http_response_code(409);
        echo json_encode(['ok' => false, 'error' => 'conflict', 'updatedAt' => $row2['updated_at']]);
        exit;
    }
    echo json_encode(['ok' => true, 'updatedAt' => $now]);
    exit;
}

http_response_code(405);
echo json_encode(['ok' => false, 'error' => 'Method not allowed.']);
