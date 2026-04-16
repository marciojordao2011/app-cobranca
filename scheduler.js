const cron = require("node-cron");

function startScheduler(generateInvoicesUpToToday) {
  cron.schedule("0 1 * * *", async () => {
    try {
      await generateInvoicesUpToToday();
      console.log("[scheduler] cobranças geradas com sucesso");
    } catch (error) {
      console.error("[scheduler] erro ao gerar cobranças:", error);
    }
  });
}

module.exports = {
  startScheduler
};