const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Display startup banner
console.log('\n=======================================================');
console.log('   Advanced WhatsApp Chatbot - Three-Engine Architecture');
console.log('=======================================================\n');

// Check for required directories
const requiredDirs = ['uploads', 'engines', 'models', 'utils'];
let missingDirs = false;

for (const dir of requiredDirs) {
  if (!fs.existsSync(path.join(__dirname, dir))) {
    console.error(`❌ Missing required directory: ${dir}`);
    missingDirs = true;
  }
}

if (missingDirs) {
  console.error('\n❌ Please create the missing directories before starting the application.');
  process.exit(1);
}

// Check for configuration
if (!fs.existsSync(path.join(__dirname, 'utils', 'config.js'))) {
  console.warn('⚠️  Warning: Configuration file not found at utils/config.js');
  console.warn('   Please ensure your configuration is set up correctly.');
}

console.log('✅ Starting WhatsApp Chatbot...');
console.log('🔧 Architecture: Three-Engine System');
console.log('🗄️  Reminder Engine - CRUD operations');
console.log('🔔 Notification Engine - Scheduling and delivery');
console.log('🔍 Query Engine - Information retrieval');
console.log('\n');

// Start the application
const app = exec('node app.js');

app.stdout.on('data', (data) => {
  console.log(data.trim());
});

app.stderr.on('data', (data) => {
  console.error(data.trim());
});

app.on('close', (code) => {
  if (code !== 0) {
    console.error(`\n❌ Process exited with code ${code}`);
  }
}); 