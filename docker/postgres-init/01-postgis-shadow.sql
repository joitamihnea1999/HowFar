CREATE DATABASE howfar_shadow OWNER howfar;

\connect howfar
CREATE EXTENSION IF NOT EXISTS postgis;

\connect howfar_shadow
CREATE EXTENSION IF NOT EXISTS postgis;
