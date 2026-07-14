-- Dev-only: Prisma Migrate needs to create/drop a shadow database.
-- Applied automatically on first container init (docker-entrypoint-initdb.d).
GRANT ALL PRIVILEGES ON *.* TO 'howfar'@'%';
FLUSH PRIVILEGES;
