-- Run this once against your MySQL server to create the database and table.
-- mysql -u root -p < sql/schema.sql

CREATE DATABASE IF NOT EXISTS snap_ai
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE snap_ai;

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(50)  NOT NULL DEFAULT 'employee',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
