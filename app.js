require('dotenv').config({quiet: true});
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const db = require('./models');
const sessionRefreshJob = require('./jobs/sessionRefreshJob');
const purchasePollJob = require('./jobs/purchasePollJob');
const approvalWatchJob = require('./jobs/approvalWatchJob');
const linkPaymentsJob = require('./jobs/linkPaymentsJob');

const app = express();
const port = process.env.PORT || 8009;

app.use(morgan('dev'));
app.use(express.json({limit: '1mb'}));
app.use(express.urlencoded({extended: false, limit: '20kb'}));

const whatsAppRoutes = require('./routes/whatsAppRoutes');
whatsAppRoutes(app);

db.sequelize.authenticate()
    .then(() => console.log('Database connected successfully'))
    .catch((err) => console.error('Database connection failed:', err.message));

sessionRefreshJob.start();
purchasePollJob.start();
approvalWatchJob.start();
linkPaymentsJob.start();

http.createServer(app).listen(port, () => console.log(`smatpay_whatsapp listening on ${port}`));
