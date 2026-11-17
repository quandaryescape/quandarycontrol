/* Game history helpers shared by the dashboard and the GM console (window.QC.games) */
(function () {
  'use strict';
  const { html, raw, formatTime } = QC;

  const END_REASONS = {
    time_up: "Time's up",
    reset: 'Timer reset',
    stopped: 'Timer stopped',
    interrupted: 'Interrupted (server restart or room deleted)'
  };

  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function resultBadge(g) {
    if (g.status === 'in_progress') return '<span class="badge badge-success"><span class="dot dot-success dot-pulse"></span>Playing</span>';
    if (g.result === 'escaped') return '<span class="badge badge-success"><i class="icon-trophy"></i>Escaped</span>';
    if (g.result === 'failed') return '<span class="badge badge-danger"><i class="icon-circle-x"></i>Didn\'t escape</span>';
    return '<span class="badge">No result</span>';
  }

  function row(g, { showRoom }) {
    const chat = g.playerMessages + g.gmMessages;
    const ended = g.status === 'ended';
    return html`
      <tr data-game="${g.id}" class="${g.status === 'in_progress' ? 'is-live' : ''}">
        <td><div style="font-weight:600;white-space:nowrap">${when(g.startedAt)}</div>
          <div class="faint small">${ended ? (END_REASONS[g.endReason] || '') : 'In progress'}</div></td>
        ${showRoom ? raw(html`<td><span class="${g.roomExists === false ? 'faint' : ''}">${g.roomName || 'Deleted room'}</span></td>`) : ''}
        <td>${g.teamName ? g.teamName : raw('<span class="faint">—</span>')}${g.notes ? raw(html` <i class="icon-notebook-pen faint" data-tip="${g.notes.length > 140 ? `${g.notes.slice(0, 140)}…` : g.notes}"></i>`) : ''}</td>
        <td class="mono">${formatTime(g.elapsed)}</td>
        <td class="mono">${ended ? formatTime(g.remaining) : raw('<span class="faint">—</span>')}</td>
        <td><span data-tip="${chat ? `${g.playerMessages} from players · ${g.gmMessages} from GM` : 'No chat messages'}">${g.hints}${chat ? raw(html` <span class="faint small"><i class="icon-messages-square"></i>${chat}</span>`) : ''}</span></td>
        <td>${raw(resultBadge(g))}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-icon btn-xs" data-edit aria-label="Edit game" data-tip="Team, result & notes"><i class="icon-pencil"></i></button>
          <button class="btn btn-ghost btn-icon btn-xs" data-delete aria-label="Delete game" data-tip="Delete"><i class="icon-trash-2"></i></button>
        </td>
      </tr>`;
  }

  /** HTML table of games (newest first). */
  function table(games, { showRoom = true } = {}) {
    return html`
      <div class="games-table-wrap"><table class="table games-table">
        <thead><tr>
          <th>Started</th>${showRoom ? raw('<th>Room</th>') : ''}<th>Team</th><th>Played</th><th>Time left</th><th>Hints</th><th>Result</th><th></th>
        </tr></thead>
        <tbody>${raw(games.map(g => row(g, { showRoom })).join(''))}</tbody>
      </table></div>`;
  }

  /** Edit team name, result and notes. Resolves to the updated game, or null if cancelled. */
  function edit(game) {
    let result = game.result || '';
    const body = document.createElement('div');
    body.className = 'stack-lg';
    body.innerHTML = html`
      <div class="muted small">${when(game.startedAt)} · ${game.roomName} · played ${formatTime(game.elapsed)}${game.status === 'ended' ? `, ${formatTime(game.remaining)} left` : ''}</div>
      <div class="field"><label>Result</label>
        <div class="segmented" data-result>
          <button type="button" data-v="escaped"><i class="icon-trophy"></i>Escaped</button>
          <button type="button" data-v="failed"><i class="icon-circle-x"></i>Didn't escape</button>
          <button type="button" data-v="">Not set</button>
        </div></div>
      <div class="field"><label for="game-team">Team name <span class="faint">(optional)</span></label>
        <input class="input" id="game-team" maxlength="100" value="${game.teamName}" placeholder="e.g. The Smiths"></div>
      <div class="field"><label for="game-notes">Notes <span class="faint">(optional)</span></label>
        <textarea class="textarea" id="game-notes" rows="3" maxlength="5000" placeholder="Birthday party, needed help with the safe…">${game.notes}</textarea></div>`;
    const buttons = body.querySelectorAll('[data-result] button');
    const paint = () => buttons.forEach(b => b.classList.toggle('active', b.dataset.v === result));
    buttons.forEach(b => { b.onclick = () => { result = b.dataset.v; paint(); }; });
    paint();
    return QC.modal({
      title: 'Game details', icon: 'icon-history', body,
      actions: [{ label: 'Cancel', value: null }, {
        label: 'Save', variant: 'primary',
        onClick: () => QC.put(`/api/v2/games/${encodeURIComponent(game.id)}`, {
          result: result || null,
          teamName: body.querySelector('#game-team').value,
          notes: body.querySelector('#game-notes').value
        })
      }]
    });
  }

  async function remove(game) {
    const ok = await QC.confirm({
      title: 'Delete this game?',
      message: html`${when(game.startedAt)} in ${game.roomName} will be removed from the history. This cannot be undone.`,
      confirmText: 'Delete', danger: true
    });
    if (!ok) return false;
    await QC.del(`/api/v2/games/${encodeURIComponent(game.id)}`);
    return true;
  }

  /**
   * Wire up the edit/delete buttons in a table rendered by table().
   * onChange receives the updated game, or { id, deleted: true }.
   */
  function bind(container, games, onChange) {
    container.querySelectorAll('tr[data-game]').forEach(tr => {
      const game = () => games.find(g => g.id === tr.dataset.game);
      tr.querySelector('[data-edit]').onclick = async () => {
        const updated = await edit(game());
        if (updated) { QC.toast('Game saved', 'success', { timeout: 1500 }); onChange(updated); }
      };
      tr.querySelector('[data-delete]').onclick = async () => {
        try {
          if (await remove(game())) { QC.toast('Game deleted', 'success', { timeout: 1500 }); onChange({ id: tr.dataset.game, deleted: true }); }
        } catch (err) { QC.error(err); }
      };
    });
  }

  QC.games = { END_REASONS, when, resultBadge, table, edit, remove, bind };
})();
