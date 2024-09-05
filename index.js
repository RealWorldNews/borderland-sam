// Prevent Puppeteer from downloading Chromium
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = '1';

const chromium = process.env.AWS_EXECUTION_ENV ? require('@sparticuz/chromium') : null;

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use the stealth plugin
puppeteer.use(StealthPlugin());

const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

const ARTICLE_TIMEOUT = 10000; // 10 seconds timeout for each article processing

// Function to process the article body
const processBody = (body, link, resource = 'Borderland Beat') => {
  if (!body) return '';

  let processedBody = body.replace(/<\/?a[^>]*>/gi, ''); // Remove all <a> tags
  processedBody = processedBody.replace(/<img[^>]*>/i, ''); // Remove the first image tag
  processedBody = processedBody.replace(/<br\s*\/?>/gi, '<p></p>'); // Replace <br> with <p></p>
  processedBody += `<br><br><ul><li><a href='${link}'>Read Article @ ${resource}</a></li></ul>`; // Append resource link

  return processedBody;
};

// Lambda handler function
exports.handler = async (event, context) => {
  const websiteUrl = event.url || 'https://www.borderlandbeat.com';

  if (!websiteUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify('URL is required'),
    };
  }

  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING_DEV,
  });

  const failedArticles = []; // Array to collect failed articles
  let browser;

  try {
    await client.connect();
    await client.query('DELETE FROM "Article" WHERE resource = $1', ['Borderland Beat']);

    browser = await puppeteer.launch({
      args: chromium
        ? chromium.args
        : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-browser-side-navigation',
            '--disable-infobars',
            '--disable-features=IsolateOrigins,site-per-process',
            '--enable-features=NetworkService,NetworkServiceInProcess',
          ],
      defaultViewport: chromium ? chromium.defaultViewport : null,
      executablePath: chromium ? await chromium.executablePath() : puppeteer.executablePath(),
      headless: chromium ? chromium.headless : true,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    try {
      await page.goto(websiteUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (error) {
      console.error('Failed to load Borderland Beat homepage:', error);
      await browser.close();
      await client.end();
      return {
        statusCode: 500,
        body: JSON.stringify('Failed to load the website'),
      };
    }

    const articles = await page.$$eval('.wrapfullpost .post', (items) =>
      items.map((item) => {
        const headline = item.querySelector('.post-title a')?.innerText.trim();
        const link = item.querySelector('.post-title a')?.href.trim();
        const author = item.querySelector('.meta_pbtauthor a')?.innerText.trim();
        const date = item.querySelector('.meta_date')?.innerText.trim();
        const slug = headline
          .split(' ')
          .slice(0, 3)
          .join('')
          .toLowerCase()
          .replace(/[^a-z]/g, '');
        const summary = item
          .querySelector('.post-body')
          ?.innerText.split(' ')
          .slice(0, 40)
          .join(' ')
          .trim();
        let image = item.querySelector('.pbtthumbimg')?.src;
        if (!image) {
          image = item.querySelector('.post img')?.src;
        }
        if (!image) {
          image =
            'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEiqWgv9a-GMfeFVR99PY7T29fcpWUc-Oa8HAekzlXDRInvZXoQIpjpWnkq4pQfieGT4SPMYu0RkDKiUb80irZ4n_PizrnqKz7HlCKVtWLpnEeEfldWY1z-LtkEANuFOhd0oYxHo9YIGaP2Ii9tGtVh8kWSErRvee2ewBKJa1PfidOM8nglZZvOBQ4UXxpMG/s320/telegram-bb.png';
        }
        return { headline, link, slug, author, date, summary, image };
      })
    );

    for (const article of articles) {
      let articlePage;
      try {
        console.log(`Navigating to article: ${article.link}`);
    
        // Open a new page for each article to avoid issues
        articlePage = await browser.newPage();
    
        // Attempt to navigate to the article page with a timeout
        await Promise.race([
          articlePage.goto(article.link, {
            waitUntil: 'domcontentloaded',
            timeout: 3000, // Timeout for the navigation
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Article timeout')), ARTICLE_TIMEOUT)),
        ]);
    
        console.log(`Successfully loaded article: ${article.link}`);
    
        // Wait for the .post-body selector and extract its content
        const bodyHtml = await articlePage.$eval('.post-body', (el) => el.innerHTML);
    
        if (bodyHtml.trim() !== '') {
          // Process the .post-body content
          article.body = processBody(bodyHtml, article.link);
        } else {
          throw new Error('Article body is empty');
        }
    
        // Insert into the database
        await client.query(
          `INSERT INTO "Article" (id, slug, headline, summary, body, author, resource, media, link, date)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            cuid(),
            article.slug,
            article.headline,
            article.summary || '',
            article.body || '',
            article.author || 'Unknown',
            'Borderland Beat',
            article.image,
            article.link,
            article.date || new Date().toISOString(),
          ]
        );
      } catch (error) {
        console.error(`Error processing article: ${article.link} - ${article.headline}`, error);
    
        // Log the HTML of the page that caused the error
        if (articlePage) {
          try {
            const pageContent = await articlePage.content();
            console.log(`HTML content of the failed page: ${pageContent}`);
          } catch (contentError) {
            console.error('Failed to retrieve HTML content:', contentError);
          }
        }
    
        failedArticles.push(article.headline); // Log the title of the failed article
      } finally {
        if (articlePage) {
          await articlePage.close(); // Ensure the page is closed after processing
        }
      }
    }

    console.log('Failed articles:', failedArticles); // Log all failed articles

    return {
      statusCode: 200,
      body: JSON.stringify('Scraping completed successfully'),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify('An error occurred during scraping'),
    };
  } finally {
    await client.end();
    if (browser) await browser.close();
  }
};
