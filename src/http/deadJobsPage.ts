export function renderDeadJobsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dead jobs</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f4f5f7; color: #222; }
    h1 { margin-top: 0; }
    .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .message { padding: 8px 12px; border-radius: 4px; }
    .message.ok { background: #e6f4ea; color: #1e4620; }
    .message.err { background: #fdecea; color: #8b1e1e; }
    .count { color: #555; }
    table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e3e6ea; vertical-align: top; }
    th { background: #eceff3; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
    .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; background: #fafbfc; padding: 6px; border: 1px solid #e3e6ea; border-radius: 4px; }
    button.retry { background: #1a73e8; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    button.retry:disabled { background: #9aa7b1; cursor: default; }
    .empty { padding: 24px; text-align: center; color: #555; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  </style>
</head>
<body>
  <h1>Dead-letter view</h1>
  <p class="count">Dead jobs that exhausted their retry budget can be inspected and manually retried here.</p>
  <div class="toolbar">
    <button id="refresh" class="retry">Refresh</button>
    <span id="message" class="message"></span>
  </div>
  <div id="content">
    <div class="empty">Loading dead jobs…</div>
  </div>

  <script>
    const endpoint = '/api/jobs/dead';
    const listEl = document.getElementById('content');
    const messageEl = document.getElementById('message');

    function iso(ts) {
      if (!ts) return '—';
      try { return new Date(ts).toLocaleString(); } catch (_) { return ts; }
    }

    function showMessage(text, ok) {
      messageEl.textContent = text || '';
      messageEl.className = 'message ' + (ok ? 'ok' : 'err');
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function payloadPre(payload) {
      try {
        return '<pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>';
      } catch (_) {
        return '<pre>' + escapeHtml(String(payload)) + '</pre>';
      }
    }

    function renderDeadJobs(jobs) {
      if (!jobs || jobs.length === 0) {
        listEl.innerHTML = '<div class="empty">No dead jobs.</div>';
        return;
      }
      const rows = jobs.map(function (j) {
        return '<tr>' +
          '<td class="mono">' + escapeHtml(j.id) + '</td>' +
          '<td>' + escapeHtml(j.type) + '</td>' +
          '<td>' + payloadPre(j.payload) + '</td>' +
          '<td>' + escapeHtml(j.attempts) + ' / ' + escapeHtml(j.maxAttempts) + '</td>' +
          '<td class="mono">' + (j.lastError ? escapeHtml(j.lastError) : '—') + '</td>' +
          '<td class="mono">' + escapeHtml(iso(j.createdAt)) + '<br />' +
            'run: ' + escapeHtml(iso(j.runAt)) + '<br />' +
            'started: ' + escapeHtml(iso(j.startedAt)) + '<br />' +
            'finished: ' + escapeHtml(iso(j.finishedAt)) + '</td>' +
          '<td><button class="retry" data-id="' + escapeHtml(j.id) + '">Retry</button></td>' +
        '</tr>';
      }).join('');
      listEl.innerHTML =
        '<table><thead><tr>' +
        '<th>Job ID</th><th>Type</th><th>Payload</th><th>Attempts / Max</th>' +
        '<th>Last error</th><th>Timestamps</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';

      listEl.querySelectorAll('button.retry').forEach(function (btn) {
        btn.addEventListener('click', function () { retryJob(btn); });
      });
    }

    function loadDeadJobs() {
      listEl.innerHTML = '<div class="empty">Loading dead jobs…</div>';
      fetch(endpoint)
        .then(function (res) {
          if (!res.ok) { throw new Error('HTTP ' + res.status); }
          return res.json();
        })
        .then(function (data) { renderDeadJobs(data.jobs); })
        .catch(function (err) {
          listEl.innerHTML = '<div class="empty">Failed to load dead jobs: ' + escapeHtml(err.message) + '</div>';
          showMessage('Failed to load dead jobs.', false);
        });
    }

    function retryJob(btn) {
      const id = btn.getAttribute('data-id');
      btn.disabled = true;
      btn.textContent = '…';
      showMessage('Retrying ' + id + '…', true);
      fetch('/api/jobs/' + encodeURIComponent(id) + '/retry', { method: 'POST' })
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) {
              const detail = (body && body.error && body.error.message) || ('HTTP ' + res.status);
              throw new Error(detail);
            }
            return body;
          });
        })
        .then(function (body) {
          const job = body.job;
          showMessage('Retried job ' + job.id + ' — now ' + job.status + ' (attempts=' + job.attempts + ').', true);
          loadDeadJobs();
        })
        .catch(function (err) {
          showMessage('Retry failed: ' + err.message, false);
          btn.disabled = false;
          btn.textContent = 'Retry';
        });
    }

    document.getElementById('refresh').addEventListener('click', function () {
      showMessage('');
      loadDeadJobs();
    });

    loadDeadJobs();
  </script>
</body>
</html>`;
}