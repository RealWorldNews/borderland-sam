require('dotenv').config(); // Load environment variables
const { handler } = require('./index'); // Adjust the path to your Lambda function file

(async () => {
  const event = {
    url: 'https://www.borderlandbeat.com' // Example URL for Borderland Beat
  };

  const context = {}; // Mock context object if needed

  try {
    const result = await handler(event, context);
    console.log('Lambda function result:', result);
  } catch (error) {
    console.error('Error running the Lambda function locally:', error);
  }
})();
