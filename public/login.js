document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const res = await fetch('/api/knot/session', {
    method: 'POST',
    headers: { 'X-Knot-Client': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: form.get('name'), password: form.get('password') }),
  });
  if (res.ok) {
    const params = new URLSearchParams(location.search);
    location.href = params.get('next') ?? '/';
    return;
  }
  const msg = res.status === 429 ? '試行回数が多すぎます。しばらく待ってください。' : 'ユーザー名またはパスワードが違います。';
  let p = document.querySelector('.error');
  if (!p) {
    p = document.createElement('p');
    p.className = 'error';
    e.target.appendChild(p);
  }
  p.textContent = msg;
});
