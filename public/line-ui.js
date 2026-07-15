function highlight() {
  document.querySelectorAll('.line-row.highlight').forEach((element) => element.classList.remove('highlight'));
  if (!/^#L.+$/.test(location.hash)) return;
  const element = document.getElementById(location.hash.slice(1));
  if (!element) return;
  element.classList.add('highlight');
  element.scrollIntoView({ block: 'center' });
}

window.addEventListener('hashchange', highlight);
highlight();

const relativeTimeFormatter = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' });

function relativeTime(unixSeconds) {
  const difference = unixSeconds - Math.floor(Date.now() / 1000);
  const absoluteDifference = Math.abs(difference);
  if (absoluteDifference < 3600) return relativeTimeFormatter.format(Math.round(difference / 60), 'minute');
  if (absoluteDifference < 86400) return relativeTimeFormatter.format(Math.round(difference / 3600), 'hour');
  return relativeTimeFormatter.format(Math.round(difference / 86400), 'day');
}

const exactTimeFormatter = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' });

document.querySelectorAll('.telomere').forEach((element) => {
  const updated = Number(element.dataset.updated);
  element.title = relativeTime(updated);
  element.addEventListener('click', () => {
    const exact = exactTimeFormatter.format(new Date(updated * 1000));
    alert(`${exact} / ${element.dataset.user}`);
  });
});
