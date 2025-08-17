async function search() {
  const q = document.getElementById("searchBox").value.trim();
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();

  const container = document.getElementById("results");
  container.innerHTML = "";

  data.forEach(p => {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
      <img src="${p.img}" alt="">
      <h3>${p.title}</h3>
      <p>${p.partNumber}</p>
      <p>${p.price}</p>
      <small>${p.source}</small>
    `;
    container.appendChild(div);
  });
}
