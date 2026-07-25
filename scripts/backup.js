/** Manual backup runner: `npm run db:backup` */
'use strict';
const { runBackup } = require('../src/services/schedulerService');
runBackup().then((ok) => process.exit(ok ? 0 : 1));
