const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "123456";

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email
    },
    SECRET,
    { expiresIn: "7d" }
  );
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth) {
    return res.status(401).json({ error: "Token não enviado." });
  }

  const token = auth.split(" ")[1];

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }
}

module.exports = {
  generateToken,
  authMiddleware
};