// A "dev server" that never accepts connections (for the startup-timeout test).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(__dirname, 'pids.json'), JSON.stringify({ server: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
