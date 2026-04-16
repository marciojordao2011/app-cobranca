const cron = require("node-cron");

function startScheduler(generateFn) {
  cron.schedule("0 2 * * *", async () => {
    try {
      console.log("Rodando fechamento automático...");
      await generateFn();
      console.log("Fechamento concluído.");
    } catch (error) {
      console.error("Erro no scheduler:", error);
    }
  });
}

module.exports = {
  startScheduler
};