/* NERIX — сервер с файлом аккаунтов, второй валютой, друзьями */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 7000;
const USERS_FILE = path.join(__dirname, 'users.json');

/* ==================== ЗАГРУЗКА АККАУНТОВ ==================== */
let users = {};
try {
  if (fs.existsSync(USERS_FILE)) {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    console.log('✓ Загружено аккаунтов:', Object.keys(users).length);
  }
} catch (e) {
  console.log('✗ Не удалось загрузить users.json:', e.message);
}

let saveTimer = null;
function saveUsers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
      console.log('✗ Ошибка сохранения:', e.message);
    }
  }, 500);
}
process.on('SIGINT', () => {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch {}
  console.log('\n✓ Аккаунты сохранены. Выход.');
  process.exit(0);
});

/* ==================== ЗАДАНИЯ ==================== */
const TASKS_TEMPLATE = [
  {id:'play_first', name:'Сыграть первый раз', reward:50, hint:'Зайди в игру'},
  {id:'walk_100', name:'Пройти 100 метров', reward:60, hint:'Ходи'},
  {id:'shoot_10', name:'Сделать 10 выстрелов', reward:80, hint:'Стреляй'},
  {id:'rocket_3', name:'Запустить 3 ракеты', reward:120, hint:'Ракеты'},
  {id:'destroy_1', name:'Разрушить здание', reward:100, hint:'Взорви'},
  {id:'chat_1', name:'Написать в чат', reward:30, hint:'Сообщение'},
  {id:'visit_3', name:'Посетить 3 плейса', reward:120, hint:'Меняй карты'},
  {id:'buy_first', name:'Купить первый предмет', reward:40, hint:'Каталог'},
  {id:'jump_10', name:'Прыгнуть 10 раз', reward:50, hint:'Прыгай'},
  {id:'kill_health', name:'Потерять здоровье', reward:70, hint:'Урон'},
  {id:'die_fall', name:'Упасть с высоты', reward:40, hint:'Сорвись'},
  {id:'add_friend', name:'Добавить друга', reward:100, hint:'Найди друга'}
];

/* ==================== ОНЛАЙН ==================== */
const players = {};
let nextId = 1;

function pubUser(u) {
  return {
    nick: u.nick, nerixs: u.nerixs, nelsi: u.nelsi || 0,
    inventory: u.inventory, equipped: u.equipped,
    friends: u.friends, bonusClaimed: u.bonusClaimed,
    tasks: u.tasks, stats: u.stats
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Не найден index.html');
    }
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = nextId++;
  ws.id = id;
  console.log('+ Подключён', id);

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    /* ---------- РЕГИСТРАЦИЯ ---------- */
    if (m.type === 'register') {
      const nick = (m.nick || '').trim();
      if (nick.length < 3) return ws.send(JSON.stringify({type:'authResult', ok:false, msg:'Ник минимум 3'}));
      if ((m.pass || '').length < 3) return ws.send(JSON.stringify({type:'authResult', ok:false, msg:'Пароль минимум 3'}));
      if (users[nick.toLowerCase()]) return ws.send(JSON.stringify({type:'authResult', ok:false, msg:'Ник занят'}));
      users[nick.toLowerCase()] = {
        nick, pass: m.pass, nerixs: 100, nelsi: 0,
        inventory: [], equipped: {}, friends: [],
        bonusClaimed: false,
        tasks: TASKS_TEMPLATE.map(t => ({...t, done: false})),
        stats: {shots:0, rockets:0, destroyed:0, walked:0, jumps:0, visitedPlaces:[]}
      };
      saveUsers();
      players[id] = { nick, x:0, y:1, z:0, yaw:0, walking:false, walkPhase:0, place:0, health:100, equipped:{} };
      ws.nick = nick;
      ws.send(JSON.stringify({type:'authResult', ok:true, user: pubUser(users[nick.toLowerCase()])}));
      broadcastPlayers();
      broadcastChat({system:true, text:nick + ' присоединился'});
      return;
    }

    /* ---------- ВХОД ---------- */
    if (m.type === 'login') {
      const u = users[(m.nick || '').toLowerCase()];
      if (!u) return ws.send(JSON.stringify({type:'authResult', ok:false, msg:'Не найден'}));
      if (u.pass !== m.pass) return ws.send(JSON.stringify({type:'authResult', ok:false, msg:'Неверный пароль'}));
      if (u.nelsi === undefined) u.nelsi = 0;
      players[id] = { nick: u.nick, x:0, y:1, z:0, yaw:0, walking:false, walkPhase:0, place:0, health:100, equipped: u.equipped };
      ws.nick = u.nick;
      ws.send(JSON.stringify({type:'authResult', ok:true, user: pubUser(u)}));
      broadcastPlayers();
      broadcastChat({system:true, text:u.nick + ' присоединился'});
      return;
    }

    if (!ws.nick) return;
    const u = users[ws.nick.toLowerCase()];
    if (!u) return;

    /* ---------- ДВИЖЕНИЕ ---------- */
    if (m.type === 'move') {
      const p = players[id]; if (!p) return;
      p.x = m.x; p.y = m.y; p.z = m.z; p.yaw = m.yaw;
      p.walking = m.walking; p.walkPhase = m.walkPhase;
      p.place = m.place; p.health = m.health;
      p.equipped = u.equipped;
      broadcastPlayers();
      return;
    }

    /* ---------- ЧАТ ---------- */
    if (m.type === 'chat') {
      const txt = (m.text || '').slice(0, 120);
      if (!txt.trim()) return;
      broadcastChat({from: u.nick, text: txt});
      completeTaskServer(u, 'chat_1');
      return;
    }

    /* ---------- ЗАДАНИЕ ВЫПОЛНЕНО ---------- */
    if (m.type === 'taskDone') { completeTaskServer(u, m.taskId); return; }

    /* ---------- БОНУС +50 (только нериксы) ---------- */
    if (m.type === 'bonus') {
      if (u.bonusClaimed) return ws.send(JSON.stringify({type:'bonusResult', ok:false, msg:'Уже получен'}));
      u.nerixs += 50; u.bonusClaimed = true; saveUsers();
      ws.send(JSON.stringify({type:'userUpdate', user: pubUser(u)}));
      return;
    }

    /* ---------- ПОКУПКА ---------- */
    /* Обычные предметы — за нелси. Лимитки — за нериксы. */
    if (m.type === 'buy') {
      const item = m.item; if (!item) return;
      if (u.inventory.includes(item.id)) return;

      const currency = item.limited ? 'nerixs' : 'nelsi';
      const have = currency === 'nerixs' ? u.nerixs : (u.nelsi || 0);

      if (have < item.price) {
        return ws.send(JSON.stringify({
          type:'buyResult', ok:false,
          msg: 'Мало ' + (currency === 'nerixs' ? 'Nerixs' : 'Nelsi')
        }));
      }
      if (currency === 'nerixs') u.nerixs -= item.price;
      else u.nelsi = (u.nelsi || 0) - item.price;

      u.inventory.push(item.id);
      saveUsers();
      ws.send(JSON.stringify({type:'userUpdate', user: pubUser(u)}));
      completeTaskServer(u, 'buy_first');
      return;
    }

    /* ---------- НАДЕТЬ/СНЯТЬ ---------- */
    if (m.type === 'equip') {
      const { itemId, slot } = m;
      if (itemId === null || itemId === undefined) {
        delete u.equipped[slot];
      } else if (u.equipped[slot] === itemId) {
        delete u.equipped[slot];
      } else {
        u.equipped[slot] = itemId;
      }
      saveUsers();
      ws.send(JSON.stringify({type:'userUpdate', user: pubUser(u)}));
      if (players[id]) players[id].equipped = u.equipped;
      broadcastPlayers();
      return;
    }

    /* ---------- ДРУЗЬЯ ---------- */
    if (m.type === 'addFriend') {
      const t = (m.nick || '').trim().toLowerCase();
      if (!t) return ws.send(JSON.stringify({type:'friendResult', ok:false, msg:'Введи ник'}));
      if (!users[t]) return ws.send(JSON.stringify({type:'friendResult', ok:false, msg:'Не найден'}));
      if (t === ws.nick.toLowerCase()) return ws.send(JSON.stringify({type:'friendResult', ok:false, msg:'Это вы'}));
      if (u.friends.includes(t)) return ws.send(JSON.stringify({type:'friendResult', ok:false, msg:'Уже друг'}));
      u.friends.push(t);
      if (!users[t].friends.includes(ws.nick.toLowerCase())) users[t].friends.push(ws.nick.toLowerCase());
      saveUsers();
      completeTaskServer(u, 'add_friend');
      ws.send(JSON.stringify({type:'friendResult', ok:true, user: pubUser(u)}));
      // Обновить второго игрока если онлайн
      wss.clients.forEach(cl => {
        if (cl.nick && cl.nick.toLowerCase() === t && cl.readyState === 1) {
          cl.send(JSON.stringify({type:'userUpdate', user: pubUser(users[t])}));
        }
      });
      return;
    }

    /* ---------- УДАЛИТЬ ДРУГА ---------- */
    if (m.type === 'removeFriend') {
      const t = (m.nick || '').trim().toLowerCase();
      u.friends = u.friends.filter(f => f !== t);
      if (users[t]) users[t].friends = users[t].friends.filter(f => f !== ws.nick.toLowerCase());
      saveUsers();
      ws.send(JSON.stringify({type:'userUpdate', user: pubUser(u)}));
      if (users[t]) {
        wss.clients.forEach(cl => {
          if (cl.nick && cl.nick.toLowerCase() === t && cl.readyState === 1) {
            cl.send(JSON.stringify({type:'userUpdate', user: pubUser(users[t])}));
          }
        });
      }
      return;
    }

    /* ---------- СТАТИСТИКА ---------- */
    if (m.type === 'stats') {
      const s = m.stats || {};
      u.stats.shots = (u.stats.shots||0) + (s.shots||0);
      u.stats.rockets = (u.stats.rockets||0) + (s.rockets||0);
      u.stats.destroyed = (u.stats.destroyed||0) + (s.destroyed||0);
      u.stats.walked = (u.stats.walked||0) + (s.walked||0);
      u.stats.jumps = (u.stats.jumps||0) + (s.jumps||0);
      if (s.die) completeTaskServer(u, 'die_fall');
      if (s.kill_health) completeTaskServer(u, 'kill_health');
      checkTaskServer(u);
      saveUsers();
      return;
    }

    /* ---------- ПОСЕЩЕНИЕ ПЛЕЙСА ---------- */
    if (m.type === 'visit') {
      if (!u.stats.visitedPlaces) u.stats.visitedPlaces = [];
      if (!u.stats.visitedPlaces.includes(m.place)) u.stats.visitedPlaces.push(m.place);
      checkTaskServer(u);
      saveUsers();
      return;
    }
  });

  ws.on('close', () => {
    if (ws.nick) {
      broadcastChat({system:true, text: ws.nick + ' вышел'});
      delete players[id];
      broadcastPlayers();
    }
  });
});

/* ==================== ЗАДАНИЯ ==================== */
function checkTaskServer(u) {
  const s = u.stats || {};
  if (s.shots >= 10) completeTaskServer(u, 'shoot_10');
  if (s.rockets >= 3) completeTaskServer(u, 'rocket_3');
  if (s.destroyed >= 1) completeTaskServer(u, 'destroy_1');
  if (s.walked >= 100) completeTaskServer(u, 'walk_100');
  if (s.jumps >= 10) completeTaskServer(u, 'jump_10');
  if ((s.visitedPlaces || []).length >= 3) completeTaskServer(u, 'visit_3');
}

function completeTaskServer(u, taskId) {
  if (!u.tasks) return;
  const t = u.tasks.find(x => x.id === taskId);
  if (!t || t.done) return;
  t.done = true;
  /* Все задания дают ТОЛЬКО нелси */
  u.nelsi = (u.nelsi || 0) + t.reward;
  saveUsers();
  wss.clients.forEach(cl => {
    if (cl.nick && cl.nick.toLowerCase() === u.nick.toLowerCase() && cl.readyState === 1) {
      cl.send(JSON.stringify({type:'userUpdate', user: pubUser(u)}));
      cl.send(JSON.stringify({type:'taskNotify', name: t.name, reward: t.reward}));
    }
  });
}

/* ==================== РАССЫЛКА ==================== */
function broadcastPlayers() {
  const list = Object.values(players).map(p => ({
    nick: p.nick, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
    walking: p.walking, walkPhase: p.walkPhase, place: p.place, health: p.health,
    equipped: p.equipped || {}
  }));
  const msg = JSON.stringify({type:'players', list});
  wss.clients.forEach(cl => { if (cl.readyState === 1) cl.send(msg); });
}
function broadcastChat(msg) {
  const s = JSON.stringify({type:'chat', ...msg, time: Date.now()});
  wss.clients.forEach(cl => { if (cl.readyState === 1) cl.send(s); });
}

/* ==================== СТАРТ ==================== */
server.listen(PORT, () => {
  console.log('');
  console.log('✅ NERIX сервер запущен: http://localhost:' + PORT);
  console.log('   Аккаунтов в базе:', Object.keys(users).length);
  console.log('   Файл аккаунтов:', USERS_FILE);
  console.log('');
});