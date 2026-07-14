-- Dev-only, least-privilege: the app user owns exactly its database plus the
-- pinned Prisma Migrate shadow database (see prisma.config.ts) — not *.*.
-- An explicitly configured shadow database must pre-exist (Prisma only resets
-- its contents). Applied automatically on first container init.
CREATE DATABASE IF NOT EXISTS `howfar_shadow`;
GRANT ALL PRIVILEGES ON `howfar`.* TO 'howfar'@'%';
GRANT ALL PRIVILEGES ON `howfar_shadow`.* TO 'howfar'@'%';
FLUSH PRIVILEGES;
