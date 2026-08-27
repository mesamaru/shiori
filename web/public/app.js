// web/public/app.js
// 担当者ピッカーのプログレッシブエンハンスメント。
//
// サーバー側は通常の <select name="assignee_id"> を必ず描画する
// （JS無効でもフォームとして機能するのはこのため）。
// このスクリプトは、その <select> を隠して代わりにアバター付き・
// 検索可能なUIを表示し、選択結果を <select> の値へ同期するだけ。
// フォームの送信先・パラメータ名は一切変えない。
//
// 外部ライブラリなし。innerHTMLへの生文字列挿入は行わず、
// すべて createElement + textContent でノードを組み立てる
// （渡されるメンバー名がどこかで由来を辿れなくなってもXSSにならないように）。

(function () {
  'use strict';

  function normalize(text) {
    return String(text || '').toLowerCase();
  }

  function enhance(root) {
    const select = root.querySelector('select.assignee-native');
    if (!select) return;

    let members;
    try {
      members = JSON.parse(root.dataset.members || '[]');
    } catch {
      return; // データが壊れていたら何もせず素の<select>のまま使わせる
    }

    select.hidden = true;

    const wrap = document.createElement('div');
    wrap.className = 'apick';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'apick-trigger';

    const triggerAvatar = document.createElement('span');
    triggerAvatar.className = 'apick-avatar apick-avatar-sm';
    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'apick-label';
    trigger.appendChild(triggerAvatar);
    trigger.appendChild(triggerLabel);

    const panel = document.createElement('div');
    panel.className = 'apick-panel';
    panel.hidden = true;

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'apick-search';
    search.placeholder = '名前で検索…';
    search.autocomplete = 'off';

    const list = document.createElement('ul');
    list.className = 'apick-list';

    function setTrigger(id, name, avatar) {
      triggerLabel.textContent = name || '未定';
      if (avatar) {
        triggerAvatar.style.backgroundImage = 'url(' + JSON.stringify(avatar) + ')';
        triggerAvatar.classList.remove('apick-avatar-empty');
      } else {
        triggerAvatar.style.backgroundImage = '';
        triggerAvatar.classList.add('apick-avatar-empty');
      }
    }

    function select_(id, name, avatar) {
      select.value = id;
      setTrigger(id, name, avatar);
      close();
    }

    function buildRow(m) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'apick-row';

      const av = document.createElement('span');
      av.className = 'apick-avatar apick-avatar-sm';
      if (m.avatar) av.style.backgroundImage = 'url(' + JSON.stringify(m.avatar) + ')';
      else av.classList.add('apick-avatar-empty');

      const label = document.createElement('span');
      label.textContent = m.name;

      btn.appendChild(av);
      btn.appendChild(label);
      btn.addEventListener('click', () => select_(m.id, m.name, m.avatar));
      li.appendChild(btn);
      return li;
    }

    // 「未定」行
    const emptyRow = document.createElement('li');
    const emptyBtn = document.createElement('button');
    emptyBtn.type = 'button';
    emptyBtn.className = 'apick-row';
    const emptyAvatar = document.createElement('span');
    emptyAvatar.className = 'apick-avatar apick-avatar-sm apick-avatar-empty';
    const emptyLabel = document.createElement('span');
    emptyLabel.textContent = '未定';
    emptyBtn.appendChild(emptyAvatar);
    emptyBtn.appendChild(emptyLabel);
    emptyBtn.addEventListener('click', () => select_('', '', null));
    emptyRow.appendChild(emptyBtn);

    const rows = members.map(buildRow);

    function renderList(filter) {
      list.textContent = '';
      const q = normalize(filter);
      list.appendChild(emptyRow);
      for (let i = 0; i < members.length; i++) {
        if (!q || normalize(members[i].name).includes(q)) list.appendChild(rows[i]);
      }
    }

    function open() {
      panel.hidden = false;
      renderList('');
      search.value = '';
      search.focus();
    }
    function close() {
      panel.hidden = true;
    }

    trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
    search.addEventListener('input', () => renderList(search.value));
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    panel.appendChild(search);
    panel.appendChild(list);
    wrap.appendChild(trigger);
    wrap.appendChild(panel);
    select.insertAdjacentElement('afterend', wrap);

    // 初期表示（サーバー側で選択済みだったoptionを反映）
    const current = members.find((m) => m.id === select.value);
    setTrigger(select.value, current ? current.name : '', current ? current.avatar : null);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.assignee-picker').forEach(enhance);
  });
})();
