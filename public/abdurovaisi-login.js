const loginForm = document.querySelector("#loginForm");
const loginStatus = document.querySelector("#loginStatus");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginStatus.textContent = "Checking password...";

  const formData = new FormData(loginForm);
  const response = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: formData.get("password") }),
  });
  const data = await response.json();

  if (!response.ok) {
    loginStatus.textContent = data.error || "Login failed";
    return;
  }

  window.location.href = "./abdurovaisi.html";
});
