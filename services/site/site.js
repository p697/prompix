const zh = document.documentElement.lang.startsWith('zh');
const modal = document.querySelector('dialog');
let trigger;
for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => {
    const example = document.getElementById(button.dataset.example);
    modal.querySelector('h2').textContent = button.querySelector('h3').innerText.replace(/\n/g, ' ');
    modal.querySelector('pre').textContent = example.content.querySelector('pre').textContent;
    modal.querySelector('[role=status]').textContent = '';
    trigger = button;
    modal.showModal();
  });
}
if (modal) {
  modal.querySelector('.close').addEventListener('click', () => modal.close());
  modal.addEventListener('close', () => trigger?.focus());
  modal.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(modal.querySelector('pre').textContent);
      modal.querySelector('[role=status]').textContent = zh ? '已复制，去创造吧。' : 'Copied. Make it yours.';
    } catch {
      modal.querySelector('[role=status]').textContent = zh ? '请选中上方文字并复制。' : 'Select the prompt above and copy it.';
    }
  });
}
const issueLink = document.querySelector('[data-report]');
if (issueLink) {
  // Only a public content ID enters the URL. Never include a user's draft or saved data.
  const id = new URLSearchParams(location.search).get('id');
  if (id && /^[a-z0-9-]{1,180}$/.test(id)) {
    document.querySelector('[data-content-id]').textContent = id;
    document.querySelector('[data-context]').hidden = false;
    const url = new URL(issueLink.href);
    url.searchParams.set('content-id', id);
    issueLink.href = url.href;
    const languageLink = document.querySelector('.language');
    const translated = new URL(languageLink.href);
    translated.searchParams.set('id', id);
    languageLink.href = translated.href;
  }
}
