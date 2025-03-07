const express = require("express");
const cors = require("cors");
const consola = require("consola");
const dotenv = require("dotenv");
const { v4: uuid } = require("uuid");
const { hmacValidator } = require("@adyen/api-library");
const { Client, Config, CheckoutAPI } = require("@adyen/api-library");
const { Nuxt, Builder } = require("nuxt");
const fetch = require("node-fetch");

// init app
const app = express();
// Parse JSON bodies
app.use(express.json());
// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));
// Enable all CORS Requests
app.use(cors());

// Import and set Nuxt.js options
const nuxtConfig = require("../nuxt.config.js");
nuxtConfig.dev = process.env.NODE_ENV !== "production";

// Enables environment variables by parsing the .env file and assigning it to process.env
dotenv.config({
  path: "./.env",
});

// Adyen Node.js API library boilerplate (configuration, etc.)
const config = new Config();
config.apiKey = process.env.ADYEN_API_KEY;
const client = new Client({ config });
client.setEnvironment("TEST"); // change to LIVE for production
const checkout = new CheckoutAPI(client);

/* ################# API ENDPOINTS ###################### */

app.post("/api/payment-methods", async (req, res) => {
  try {
    const response = await fetch(
      "https://checkout-test.adyen.com/v68/paymentMethods",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "X-API-key": process.env.ADYEN_API_KEY,
        },
        body: JSON.stringify({
          merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
          shopperLocale: req.body.shopperLocale,
          countryCode: "BE",
        }),
      }
    );

    const json = await response.json();
    console.log(json);

    res.json(json);
  } catch (error) {
    console.error(error);
  }
});

// Invoke /sessions endpoint
app.post("/api/sessions", async (req, res) => {
  try {
    // unique ref for the transaction
    const orderRef = uuid();
    // Ideally the data passed here should be computed based on business logic
    const response = await checkout.sessions({
      amount: {
        currency: req.query.currency,
        value: parseInt(req.query.value, 10),
      }, // value is 10€ in minor units
      countryCode: req.query.countryCode,
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT, // required
      reference: orderRef, // required: your Payment Reference
      returnUrl: `http://localhost:8080/api/handleShopperRedirect?orderRef=${orderRef}`, // set redirect URL required for some payment methods
    });
    res.json({ response, clientKey: process.env.ADYEN_CLIENT_KEY });
  } catch (err) {
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.status(err.statusCode).json(err.message);
  }
});

// Handle all redirects from payment type
app.all("/api/handleShopperRedirect", async (req, res) => {
  // Create the payload for submitting payment details
  const redirect = req.method === "GET" ? req.query : req.body;
  const details = {};
  if (redirect.redirectResult) {
    details.redirectResult = redirect.redirectResult;
  } else if (redirect.payload) {
    details.payload = redirect.payload;
  }

  try {
    const response = await checkout.paymentsDetails({ details });
    // Conditionally handle different result codes for the shopper
    switch (response.resultCode) {
      case "Authorised":
        res.redirect("/result/success");
        break;
      case "Pending":
      case "Received":
        res.redirect("/result/pending");
        break;
      case "Refused":
        res.redirect("/result/failed");
        break;
      default:
        res.redirect("/result/error");
        break;
    }
  } catch (err) {
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.redirect("/result/error");
  }
});

// Invoke /payments endpoint
app.post("/api/payments", async (req, res) => {
  const paymentId = uuid();

  try {
    const response = await fetch(
      "https://checkout-test.adyen.com/v68/payments",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "X-API-key": process.env.ADYEN_API_KEY,
        },
        body: JSON.stringify({
          ...req.body,
          returnUrl: `${req.get("origin")}/f2/payment-result/${paymentId}`,
          merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
          reference: paymentId,
        }),
      }
    );

    const json = await response.json();
    console.log(json);

    res.json({
      paymentId,
      ...(json.action
        ? {
            redirectAction: json.action,
            redirectMethod: json.action.method,
            redirectLink: {
              type: "external",
              href: json.action.url,
            },
            redirectData: json.action.data,
          }
        : {
            redirectMethod: "GET",
            redirectLink: {
              type: "internal",
              name: "checkout_payment_result",
              params: { paymentId },
            },
          }),
    });
  } catch (error) {
    console.error(error);
  }
});

// Invoke /payments/details endpoint
app.post("/api/payments-details", async (req, res) => {
  try {
    const { paymentId, ...body } = req.body;

    const response = await fetch(
      "https://checkout-test.adyen.com/v68/payments/details",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "X-API-key": process.env.ADYEN_API_KEY,
        },
        body: JSON.stringify(body),
      }
    );

    const json = await response.json();
    console.log(json);

    res.json({
      paymentId,
      ...(json.action
        ? {
            redirectAction: json.action,
            redirectMethod: json.action.method,
            redirectLink: {
              type: "external",
              href: json.action.url,
            },
            redirectData: json.action.data,
          }
        : {
            redirectMethod: "GET",
            redirectLink: {
              type: "internal",
              name: "checkout_payment_result",
              params: { paymentId },
            },
          }),
    });
  } catch (error) {
    console.error(error);
  }
});

/* ################# end API ENDPOINTS ###################### */

/* ################# WEBHOOK ###################### */

app.post("/api/webhooks/notifications", async (req, res) => {
  // YOUR_HMAC_KEY from the Customer Area
  const hmacKey = process.env.ADYEN_HMAC_KEY;
  const validator = new hmacValidator();
  // Notification Request JSON
  const notificationRequest = req.body;
  const notificationRequestItems = notificationRequest.notificationItems;

  // Handling multiple notificationRequests
  notificationRequestItems.forEach(function (notificationRequestItem) {
    const notification = notificationRequestItem.NotificationRequestItem;

    // Handle the notification
    if (validator.validateHMAC(notification, hmacKey)) {
      // Process the notification based on the eventCode
      const merchantReference = notification.merchantReference;
      const eventCode = notification.eventCode;
      console.log(
        "merchantReference:" + merchantReference + " eventCode:" + eventCode
      );
    } else {
      // invalid hmac: do not send [accepted] response
      console.log("Invalid HMAC signature: " + notification);
      res.status(401).send("Invalid HMAC signature");
    }
  });

  res.send("[accepted]");
});

/* ################# end WEBHOOK ###################### */

// Setup and start Nuxt.js
async function start() {
  const nuxt = new Nuxt(nuxtConfig);

  const { host, port } = nuxt.options.server;

  await nuxt.ready();
  if (nuxtConfig.dev) {
    const builder = new Builder(nuxt);
    await builder.build();
  }

  app.use(nuxt.render);

  app.listen(port, host);
  consola.ready({
    message: `Server listening on http://localhost:${port}`,
    badge: true,
  });
}
start();
