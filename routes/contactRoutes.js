const express = require("express");
const { sendContactUsMessage } = require("../controllers/contactController");
const router = express.Router();

router.post("/", sendContactUsMessage);

module.exports = router