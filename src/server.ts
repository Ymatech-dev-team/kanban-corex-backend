import "dotenv/config"; // carrega o .env no boot (dev)
import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 3001);

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`sistema-de-task-backend ouvindo em :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
