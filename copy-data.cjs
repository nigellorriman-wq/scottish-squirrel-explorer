const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

try {
  // Ensure both 'data' and 'dist/data' target folders exist
  fs.mkdirSync('data', { recursive: true });
  fs.mkdirSync('dist/data', { recursive: true });

  const rootFiles = fs.readdirSync('.');
  let countGzipped = 0;
  let countCopied = 0;

  // Patterns for species years splits
  const speciesPatterns = ['red_', 'grey_', 'marten_', 'grey_trapping_'];

  rootFiles.forEach(file => {
    // Check if the file is one of our uploaded species dataset splits
    const isSpeciesFile = speciesPatterns.some(pattern => file.startsWith(pattern));
    if (!isSpeciesFile) return;

    if (file.endsWith('.json')) {
      // Find raw JSON, compile and compress it to .json.gz in both data and dist/data
      const speciesAndYear = file.replace('.json', '');
      const targetGzName = `${speciesAndYear}.json.gz`;
      
      const srcPath = file;
      const destPathData = path.join('data', targetGzName);
      const destPathDist = path.join('dist/data', targetGzName);

      const rawContent = fs.readFileSync(srcPath);
      
      // Auto-validate JSON to ensure it is healthy
      try {
        JSON.parse(rawContent.toString('utf-8'));
      } catch (jsonErr) {
        console.warn(`[Build Data] WARNING: File ${file} contains invalid JSON: ${jsonErr.message}. Skipping...`);
        return;
      }

      const zippedContent = zlib.gzipSync(rawContent);

      fs.writeFileSync(destPathData, zippedContent);
      fs.writeFileSync(destPathDist, zippedContent);
      countGzipped++;
    } else if (file.endsWith('.json.gz')) {
      // Already gzipped, copy as-is to save bandwidth/compilation
      const destPathData = path.join('data', file);
      const destPathDist = path.join('dist/data', file);
      
      fs.copyFileSync(file, destPathData);
      fs.copyFileSync(file, destPathDist);
      countCopied++;
    }
  });

  // Also copy any other configurations or files found in data
  if (fs.existsSync('data')) {
    fs.readdirSync('data').forEach(file => {
      const src = path.join('data', file);
      const dest = path.join('dist/data', file);
      if (fs.statSync(src).isFile() && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    });
  }

  console.log(`[Build Data] Successfully compiled local database snapshot!`);
  console.log(`- Compressed and gzipped: ${countGzipped} raw JSON splits into .json.gz`);
  console.log(`- Copied already compressed: ${countCopied} .json.gz datasets`);
  console.log(`All local datasets are now fully optimized and baked into the build for free, ultra-fast container hosting!`);

} catch (e) {
  console.error('[Build Data] Failed to compile database splits:', e.message);
}
