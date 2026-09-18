// Unit tests exercise pure logic and mock out network/DB calls directly;
// they should never need a real Postgres. Some modules import the DB
// client transitively at module-load time (it validates DATABASE_URL
// eagerly, on purpose, for production fail-fast behavior), so give it a
// harmless placeholder here rather than weakening that check.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
