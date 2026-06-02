const fs = require('fs');
const path = require('path');

try {
  if (fs.existsSync('data')) {
    fs.mkdirSync('dist/data', { recursive: true });
    fs.readdirSync('data').forEach(f => {
      const src = path.join('data', f);
      const dest = path.join('dist/data', f);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dest);
      }
    });
    console.log('Database snapshot files copied into build successfully.');
  } else {
    console.log('No local data directory found to copy.');
  }
} catch (e) {
  console.error('Failed to copy database files:', e.message);
}
