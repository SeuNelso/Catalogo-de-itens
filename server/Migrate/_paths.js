const path = require('path');

/** Raiz `server/` (`.env`, `init-db.sql`, `db/`, `utils/`). */
const SERVER_ROOT = path.join(__dirname, '..');
/** Pasta com ficheiros `migrate-*.sql` e runners. */
const MIGRATE_DIR = __dirname;

function loadEnv() {
  require('dotenv').config({ path: path.join(SERVER_ROOT, '.env') });
}

function sqlInMigrate(filename) {
  return path.join(MIGRATE_DIR, filename);
}

function sqlInServer(filename) {
  return path.join(SERVER_ROOT, filename);
}

module.exports = { SERVER_ROOT, MIGRATE_DIR, loadEnv, sqlInMigrate, sqlInServer };
