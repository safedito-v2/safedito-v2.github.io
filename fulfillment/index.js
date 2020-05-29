'use strict';

const functions = require('firebase-functions');
const {WebhookClient} = require('dialogflow-fulfillment');
const {Payload} = require('dialogflow-fulfillment');
const mysql = require('mysql');
const nodemailer = require('nodemailer');

process.env.DEBUG = 'dialogflow:debug'; // enables lib debugging statements

// Custom Configurations and Variables
let emailQuery;

// Cached Global Variables
let query;
let phone;
let healthstatus;
let workcond;
let details;
let rawData;
let goodTotal = 0;
let unwellTotal = 0;
let anxiousTotal = 0;

// Configuration for nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.NODEMAILER_EMAIL,
    pass: process.env.NODEMAILER_PASSWORD
  }
});

// Configuration for MySQL Database (Google Cloud SQL)
const pool = mysql.createPool({
  connectionLimit: 100,
  // *** For Unix Socket Connection: ***
  socketPath: `/cloudsql/safedito-chatbot-nqfoxb:us-central1:dito`,
  // *** For TCP/IP Connection: ***
  // host: "HOST",
  // ip: "PORT",
  user: 'chatbot',
  password: process.env.SQL_PASSWORD,
  database: 'testdito_db'
});

function getDailyStatistics(connection) {
  console.log('method: getDailyStatistics()');

  // Get data from sql
  const query = `SELECT status, count(emp_id) as total FROM daily_health_logs WHERE isValid = 1 AND CAST(timestamp as DATE) = CURDATE() GROUP BY status;`;

  console.log('Executing SQL query: ' + query);
  return new Promise((resolve, reject) => {
    connection.query(query, (error, results, fields) => {
      console.log(results);
      resolve(results);
    });
  });
}

function getWeeklyStatistics(connection) {
  console.log('method: getWeeklyStatistics()');

  // Get data from sql
  const query = `SELECT status, count(emp_id) as total FROM daily_health_logs WHERE isValid = 1 AND CAST(timestamp as DATE) = CURDATE() GROUP BY status;`;

  console.log('Executing SQL query: ' + query);
  return new Promise((resolve, reject) => {
    connection.query(query, (error, results, fields) => {
      console.log(results);
      resolve(results);
    });
  });
}

function addDummyPayload(agent) {
  agent.add(new Payload(agent.UNSPECIFIED, {}));
}

function getAgentParameters(agent) {
  console.log('method: getAgentParameters()');

  // store temp values for null checking
  const tempQuery = agent.query;
  const tempPhone = agent.parameters.phone;
  const tempWorkCond = agent.parameters.workcondition;
  const tempHealthStatus = agent.parameters.healthstatus;
  const tempDetails = agent.parameters.details;
  console.log('Temporary Data: ', [tempQuery, tempPhone,
    tempWorkCond, tempHealthStatus, tempDetails]);

  // if passed correctly, assign to global; else, use cache
  query = (tempQuery) ? tempQuery : 'N/A';
  phone = (tempPhone) ? tempPhone : phone;
  healthstatus = (tempHealthStatus) ? tempHealthStatus : healthstatus;
  details = (tempDetails) ? JSON.stringify(tempDetails) : details;
  if (tempWorkCond == 'WFH') workcond = 1;
  else if (tempWorkCond == 'SF') workcond = 2;

  console.log('Cached Data: ', [phone, workcond, healthstatus, details]);

  return {
    emp_id: phone,
    isValid: 1,
    status: healthstatus,
    work_cond: workcond,
    details: details
  };
}

function insertDailyCheckHandler(agent) {
  console.log('method: insertDailyCheckHandler()');
  const sqlUpdateStr = 'UPDATE daily_health_logs SET isValid = 0 ' +
    'WHERE CAST(dlog_dt as DATE) = CURDATE() AND emp_id = ?';
  const sqlInsertStr = 'INSERT INTO daily_health_logs SET ? ';

  const data = getAgentParameters(agent);
  console.log(data);
  console.log(JSON.stringify(data));

  try {
    pool.getConnection((error, connection) => {
      if (error) throw error;
      console.log('Executing Queries: ? | ?', [sqlUpdateStr, sqlInsertStr]);
      connection.beginTransaction((err) => {
        connection.query(sqlUpdateStr, data.emp_id, (err) => {
          if (err) throw err; // Query uncommitted, no rollback needed
          connection.query(sqlInsertStr, data, (err) => {
            if (err) {
              console.log('SQL Exception - Rolling back SQL transaction');
              connection.rollback();
              throw err;
            }
            connection.commit();
            console.log('SQL Transaction committed');
          });
        });
      });
      connection.release();
    });
  } catch (error) {
    console.log('Handled error!' + error);
    agent.add('SQL Error' + error);
    return;
  }

  // decide next intent
  if (data.status == 1) agent.setFollowupEvent('response-good-wfh');
  else if (data.status == 2) agent.setFollowupEvent('response-unwell-wfh');
  else if (data.status == 3) agent.setFollowupEvent('send-email');
  console.log(data);
  addDummyPayload(agent);
  return;
}

function getPhoneHandler(agent) {
  console.log('method: getPhoneHandler()');
  // insert logic here: get dingtalk phone here if possible, for checking

  if (!phone) {
    phone = agent.parameters.phone;
  }
}

function getQueryHandler(agent) {
  console.log('method: getQueryHandler()');
  healthstatus = agent.parameters.healthstatus;
  console.log('healthstatus: ' + healthstatus);
  phone = (phone) ? phone : agent.parameters.phone;
  console.log('phone: ' + phone);
  emailQuery = agent.query;
  console.log('emailQuery: ' + emailQuery);
  agent.setFollowupEvent('set-anxious-workcondition');
  addDummyPayload(agent);
}

function sendEmailHandler(agent) {
  console.log('method: sendEmailHandler()');

  const mailOptions = {
    from: 'SafeDITO Chatbot', // sender address
    to: 'johnpaulomataac@gmail.com', // list of receivers
    subject: 'SafeDITO: Feeling Anxious - ' + phone, // Subject line
    html: 'Query: ' + query
  };

  console.log(mailOptions);
  transporter.sendMail(mailOptions, function(err, info) {
    if (err) {
      agent.add('Unable to send email - ' + err);
      console.log(err);
      return;
    }
  });
  agent.setFollowupEvent('send-email-confirmation');
  addDummyPayload(agent);
}
/**
 * This function will return a url link to quickchart.io
 * @param {*} chartType type of chart (bar, pie, line, etc.)
 * @param {*} chartData json for chart's x and y axis
 * @param {*} chartQuery sql query
 */
function chartifyData(chartType, chartData, chartQuery) {
  console.log('method: chartifyData()');
  try {
    pool.getConnection((error, connection) => {
      if (error) throw error;
      console.log('Executing Queries: ? | ?', chartQuery);
      connection.query(chartQuery, (error, result) => {
        if (error) throw error;
        console.log(result);
        result.forEach((row) => {
          console.log(test);
        });
      });
      connection.release();
    });
  } catch (error) {
    console.log('Handled error!' + error);
    agent.add('SQL Error' + error);
    return;
  }
  return;
}

function selectDailyChartHandler(agent) {
  console.log('method: selectDailyChartHandler()');

  pool.getConnection((error, connection) => {
    if (error) throw error;
    const sqlSelectStr = 'SELECT status, count(emp_id) as total FROM daily_health_logs WHERE isValid = 1 AND CAST(dlog_dt as DATE) = CURDATE() GROUP BY status;';
    console.log('Executing Queries: ', [sqlSelectStr]);
    connection.query(sqlSelectStr, (err, result) => {
      if (err) throw error;
      rawData = JSON.stringify(result);
      console.log(rawData);
      result.forEach(function(row) {
        if (row.status == 1) goodTotal = (row.total) ? row.total : 0;
        else if (row.status == 2) unwellTotal = (row.total) ? row.total : 0;
        else if (row.status == 3) anxiousTotal = (row.total) ? row.total : 0;
      });
      connection.end();
      console.log('Results: ' + rawData);
    });
  });

  const dataChart = {
    type: 'pie', data: {
      datasets: [{data: [goodTotal, unwellTotal, anxiousTotal]}],
      labels: ['Good', 'Unwell', 'Anxious ']
    }
  };
  const quickChart = 'https://quickchart.io/chart?bkg=white&c=' +
    encodeURIComponent(JSON.stringify(dataChart));

  console.log('QuickChart.io: ' + quickChart);
  const ctx = {
    'name': 'generate-chart', 'lifespan': 1,
    'parameters': {'urlChart': quickChart, 'today': new Date().toLocaleString()}
  };

  agent.setContext(ctx);
  agent.setFollowupEvent('daily-stats-out');
}

function weeklyChartHandler(agent) {
  console.log('method: weeklyChartHandler()');

  console.log('Before Total(s): ', goodTotal, unwellTotal, anxiousTotal);

  const dataChart = {
    type: 'bar', data: {
      datasets: [{data: [18, 27, 30, 15, 12]}],
      labels: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
    }
  };
  const quickChart = 'https://quickchart.io/chart?bkg=white&c=' +
    encodeURIComponent(JSON.stringify(dataChart));

  console.log('QuickChart.io: ' + quickChart);
  const ctx = {
    'name': 'generate-chart', 'lifespan': 1,
    'parameters': {'urlChart': quickChart, 'today': new Date().toLocaleString()}
  };

  agent.setContext(ctx);
  agent.setFollowupEvent('weekly-stats-out');
}

// Dialogflow intent mapping
exports.dialogflowFirebaseFulfillment = functions.https.onRequest(
    (request, response) => {
      const agent = new WebhookClient({request, response});
      console.log('DF Request Headers: ' + JSON.stringify(request.headers));
      console.log('DF Request Body: ' + JSON.stringify(request.body));

      // Run the function handler based on the matched Dialogflow intent name
      const intentMap = new Map();
      intentMap.set('daily-health.check-in.work-condition', insertDailyCheckHandler);
      intentMap.set('send-email', sendEmailHandler);
      intentMap.set('daily-health.checkin', getPhoneHandler);
      intentMap.set('daily-health.check-in.anxious-query', getQueryHandler);
      intentMap.set('reports.daily-stats', selectDailyChartHandler);
      intentMap.set('reports.weekly-stats', weeklyChartHandler);
      agent.handleRequest(intentMap);
    }
);
