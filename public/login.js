const form = document.getElementById("loginForm");
const errorBox = document.getElementById("errorBox");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  errorBox.style.display = "none";

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error);

    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));

    window.location.href = "/app.html";
  } catch (err) {
    errorBox.style.display = "block";
    errorBox.textContent = err.message;
  }
});