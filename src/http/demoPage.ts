export function renderDemoPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Background Job System — Demo</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f4f5f7; color: #222; margin: 0; padding: 24px; }
    .wrap { max-width: 720px; margin: 0 auto; }
    h1 { margin: 0 0 4px; }
    .intro { color: #555; margin: 0 0 20px; }
    .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.12); padding: 16px 18px; margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin: 10px 0 4px; }
    textarea, input[type="text"] { width: 100%; box-sizing: border-box; border: 1px solid #c9cfd8; border-radius: 4px; padding: 8px; font: inherit; }
    textarea { min-height: 90px; resize: vertical; }
    .row { display: flex; gap: 8px; align-items: stretch; }
    .row input { flex: 1; }
    button { border: none; border-radius: 4px; padding: 8px 14px; font: inherit; cursor: pointer; }
    button:disabled { opacity: .6; cursor: default; }
    .btn-primary { background: #1a73e8; color: #fff; margin-top: 12px; }
    .btn-secondary { background: #eceff3; color: #222; }
    a.link { color: #1a73e8; }
    #message { margin-top: 10px; padding: 8px 12px; border-radius: 4px; display: none; }
    #message.ok { display: block; background: #e6f4ea; color: #1e4620; }
    #message.err { display: block; background: #fdecea; color: #8b1e1e; }
    #message.info { display: block; background: #e8f0fe; color: #174ea6; }
    #job-status { display: none; }
    #job-status.visible { display: block; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .status-pending { background: #fef7e0; color: #6a4f00; }
    .status-processing { background: #e8f0fe; color: #174ea6; }
    .status-succeeded { background: #e6f4ea; color: #1e4620; }
    .status-failed { background: #fdecea; color: #8b1e1e; }
    .status-dead { background: #5f6368; color: #fff; }
    .sentiment-positive { background: #e6f4ea; color: #1e4620; }
    .sentiment-negative { background: #fdecea; color: #8b1e1e; }
    .sentiment-mixed { background: #fef7e0; color: #6a4f00; }
    #result-card { display: none; }
    #result-card.visible { display: block; }
    .result-row { margin-bottom: 10px; }
    .result-label { font-weight: 600; color: #555; display: block; margin-bottom: 4px; }
    .chip { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eef1f4; color: #333; font-size: 12px; margin: 2px 4px 2px 0; }
    .rating { font-size: 18px; font-weight: 700; }
    .quote { margin: 4px 0 0; padding: 8px 12px; border-left: 3px solid #1a73e8; background: #f8fafc; color: #333; }
    #job-body { width: 100%; border-collapse: collapse; margin-top: 10px; }
    #job-body th, #job-body td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3e6ea; vertical-align: top; }
    #job-body th { color: #555; font-weight: 600; width: 140px; white-space: nowrap; }
    .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
    .toolbar { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
    .muted { color: #777; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Background Job System</h1>
    <p class="intro">A customer review is queued immediately and analysed asynchronously by a separate worker.</p>

    <div class="card">
      <form id="demo-form">
        <label for="review">Customer Review</label>
        <textarea id="review" placeholder="e.g. The battery life is great but the earbuds are uncomfortable."></textarea>

        <label for="idempotencyKey">Idempotency Key</label>
        <div class="row">
          <input type="text" id="idempotencyKey" spellcheck="false" autocomplete="off" />
          <button type="button" id="generate-btn" class="btn-secondary" title="Generate a new unique key">Generate</button>
        </div>

        <button type="submit" id="submit-btn" class="btn-primary">Submit Review</button>
      </form>
      <div id="message"></div>
    </div>

    <div class="card" id="job-status">
      <h2 class="status-heading">Job Status</h2>
      <table id="job-body"></table>
      <div class="toolbar">
        <button type="button" id="refresh-btn" class="btn-secondary">Refresh Status</button>
        <span id="poll-note" class="muted"></span>
      </div>
    </div>

    <div class="card" id="result-card">
      <h2 class="status-heading">AI Analysis Result</h2>
      <div id="result-body"></div>
    </div>

    <p class="muted">
      Need to inspect failed work? Open the
      <a class="link" href="/dead-jobs">dead-letter view</a>.
    </p>
  </div>

  <script>
    (function () {
      var reviewEl = document.getElementById('review');
      var keyEl = document.getElementById('idempotencyKey');
      var formEl = document.getElementById('demo-form');
      var generateBtn = document.getElementById('generate-btn');
      var submitBtn = document.getElementById('submit-btn');
      var refreshBtn = document.getElementById('refresh-btn');
      var messageEl = document.getElementById('message');
      var statusCard = document.getElementById('job-status');
      var jobBody = document.getElementById('job-body');
      var pollNote = document.getElementById('poll-note');
      var resultCard = document.getElementById('result-card');
      var resultBody = document.getElementById('result-body');

      var currentJob = null;
      var pollTimer = null;
      var TERMINAL = ['succeeded', 'failed', 'dead'];

      function generateKey() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID();
        }
        function hex(n) {
          var s = '';
          for (var i = 0; i < n; i++) { s += Math.floor(Math.random() * 16).toString(16); }
          return s;
        }
        return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-' +
          (Math.floor(Math.random() * 4) + 8).toString(16) + hex(3) + '-' + hex(12);
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function iso(ts) {
        if (!ts) { return '\u2014'; }
        try { return new Date(ts).toLocaleString(); } catch (e) { return ts; }
      }

      function renderResult(result) {
        var parts = [];
        if (!result) {
          resultCard.classList.remove('visible');
          resultBody.innerHTML = '';
          return;
        }
        var sentiment = result.sentiment ? '<span class="badge sentiment-' + escapeHtml(String(result.sentiment)) + '">' + escapeHtml(String(result.sentiment)) + '</span>' : '\u2014';
        var rating = typeof result.rating === 'number' ? result.rating + ' / 5' : escapeHtml(result.rating);
        function chips(list) {
          if (!Array.isArray(list) || list.length === 0) {
            return '<span class="muted">None identified</span>';
          }
          return list.map(function (item) {
            return '<span class="chip">' + escapeHtml(item) + '</span>';
          }).join(' ');
        }
        parts.push('<div class="result-row"><span class="result-label">Sentiment</span>' + sentiment + '</div>');
        parts.push('<div class="result-row"><span class="result-label">Rating</span><span class="rating">' + rating + '</span></div>');
        parts.push('<div class="result-row"><span class="result-label">Themes</span>' + chips(result.themes) + '</div>');
        parts.push('<div class="result-row"><span class="result-label">Complaints</span>' + chips(result.complaints) + '</div>');
        if (typeof result.quote === 'string' && result.quote !== '') {
          parts.push('<div class="result-row"><span class="result-label">Quote</span><blockquote class="quote">' + escapeHtml(result.quote) + '</blockquote></div>');
        }
        resultBody.innerHTML = parts.join('');
        resultCard.classList.add('visible');
      }

      function stopPolling() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        pollNote.textContent = '';
      }

      function startPolling() {
        stopPolling();
        if (!currentJob || TERMINAL.indexOf(currentJob.status) !== -1) {
          pollNote.textContent = '';
          return;
        }
        pollTimer = setInterval(function () {
          fetchStatus(true);
        }, 2000);
        pollNote.textContent = 'auto-refreshing every 2s while pending/processing';
      }

      function showMessage(text, kind) {
        messageEl.textContent = text || '';
        messageEl.className = kind || 'ok';
      }

      function renderJob(job) {
        currentJob = job;
        statusCard.classList.add('visible');
        var badge = '<span class="badge status-' + escapeHtml(job.status) + '">' + escapeHtml(job.status) + '</span>';
        var rows = [
          ['Job ID', '<span class="mono">' + escapeHtml(job.id) + '</span>'],
          ['Status', badge],
          ['Attempts', escapeHtml(job.attempts) + ' / ' + escapeHtml(job.maxAttempts)],
          ['Last Error', job.lastError ? '<span class="mono">' + escapeHtml(job.lastError) + '</span>' : '\u2014'],
          ['runAt', escapeHtml(iso(job.runAt))],
          ['startedAt', escapeHtml(iso(job.startedAt))],
          ['finishedAt', escapeHtml(iso(job.finishedAt))],
          ['createdAt', escapeHtml(iso(job.createdAt))],
          ['Idempotency Key', '<span class="mono">' + escapeHtml(job.idempotencyKey) + '</span>']
        ];
        jobBody.innerHTML = rows.map(function (row) {
          return '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>';
        }).join('');
        renderResult(job.result);
        startPolling();
      }

      function fetchStatus(fromPoll) {
        if (!currentJob) { return; }
        var url = '/api/jobs/' + encodeURIComponent(currentJob.id);
        fetch(url)
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) {
                var detail = (body && body.error && body.error.message) || ('HTTP ' + res.status);
                throw new Error(detail);
              }
              return body;
            });
          })
          .then(function (body) {
            renderJob(body.job);
            if (fromPoll && TERMINAL.indexOf(body.job.status) !== -1) {
              stopPolling();
              pollNote.textContent = 'terminal state reached; polling stopped';
            }
          })
          .catch(function (err) {
            if (!fromPoll) {
              showMessage('Status refresh failed: ' + err.message, 'err');
            }
          });
      }

      generateBtn.addEventListener('click', function () {
        keyEl.value = generateKey();
      });

      formEl.addEventListener('submit', function (e) {
        e.preventDefault();
        stopPolling();
        showMessage('', '');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting\u2026';
        var body = {
          review: reviewEl.value,
          idempotencyKey: keyEl.value
        };
        fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(function (res) {
            return res.json().then(function (parsed) {
              return { ok: res.ok, parsed: parsed };
            });
          })
          .then(function (outcome) {
            if (!outcome.ok) {
              var err = outcome.parsed && outcome.parsed.error;
              var detail = err ? err.message : 'HTTP ' + 'error';
              if (err && err.details && err.details.length) {
                detail = detail + ': ' + err.details.map(function (d) {
                  return d.field + ' ' + d.message;
                }).join('; ');
              }
              throw new Error(detail);
            }
            var job = outcome.parsed.job;
            showMessage(outcome.parsed.duplicate
              ? 'Idempotency hit: that key already exists, reusing job ' + job.id + '.'
              : 'Job accepted (202) \u2014 id ' + job.id + '.', 'ok');
            renderJob(job);
          })
          .catch(function (err) {
            showMessage(err.message || 'Submission failed.', 'err');
          })
          .finally(function () {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Review';
          });
      });

      refreshBtn.addEventListener('click', function () {
        fetchStatus(false);
      });

      keyEl.value = generateKey();
    })();
  </script>
</body>
</html>`;
}