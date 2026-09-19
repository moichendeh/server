<?php
function get_pdo() {
    $cfg = require __DIR__ . '/config.php';
    $dsn = 'mysql:host=' . $cfg['db_host'] . ';dbname=' . $cfg['db_name'] . ';charset=utf8mb4';
    $pdo = new PDO($dsn, $cfg['db_user'], $cfg['db_pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('CREATE TABLE IF NOT EXISTS app_state (
        id INT PRIMARY KEY,
        data LONGTEXT NOT NULL,
        updated_at DATETIME NOT NULL
    )');
    return $pdo;
}
