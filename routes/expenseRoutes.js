const router = require("express").Router();
const { addExpense, listExpenses, getExpenseSummary } = require("../controllers/expenseController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", addExpense);
router.get("/", listExpenses);
router.get("/summary", getExpenseSummary);

module.exports = router;
