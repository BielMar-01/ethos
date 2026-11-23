// Ponto de entrada serverless da Vercel: a mesma aplicação Express, compilada em dist/ pelo build.
// vercel.json reescreve /api/* para cá; o Express recebe a URL original e roteia normalmente.
const { createApp } = require("../dist/app.js");

let app;
module.exports = (req, res) => {
  app ??= createApp();
  return app(req, res);
};
