import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidServiceName, parseScList, parseScQuery, ServiceStore } from '../services.js';
import { applyCheck, newTracked } from '../watcher.js';
import { esc, formatTransition } from '../bot.js';

test('parseScQuery: английский и русский вывод, коды ошибок', () => {
  assert.equal(parseScQuery('        STATE              : 4  RUNNING\n', 0), 'RUNNING');
  assert.equal(parseScQuery('        СОСТОЯНИЕ          : 1  STOPPED\n', 0), 'STOPPED');
  assert.equal(parseScQuery('', 1060), 'NOT_FOUND');
  assert.equal(parseScQuery('', 5), 'ACCESS_DENIED');
  assert.equal(parseScQuery('мусор', 0), 'UNKNOWN');
});

test('parseScList: имя и отображаемое имя без привязки к языку подписей', () => {
  const out = [
    'Имя_службы: QuikServerQ',
    'Выводимое_имя: QUIK Server',
    '        Тип                : 10  WIN32_OWN_PROCESS',
    '        Состояние          : 4  RUNNING',
    '',
    'SERVICE_NAME: Spooler',
    'DISPLAY_NAME: Print Spooler',
    '        TYPE               : 110  WIN32_OWN_PROCESS',
    '',
  ].join('\r\n');
  assert.deepEqual(parseScList(out), [
    { name: 'QuikServerQ', displayName: 'QUIK Server' },
    { name: 'Spooler', displayName: 'Print Spooler' },
  ]);
});

test('isValidServiceName', () => {
  assert.ok(isValidServiceName('QuikFIXAdapterService1'));
  assert.ok(!isValidServiceName('a b'));
  assert.ok(!isValidServiceName('x&calc'));
  assert.ok(!isValidServiceName(''));
});

test('applyCheck: падение и восстановление подтверждаются двумя проверками подряд', () => {
  const svc = { name: 'S', label: 'S' };
  const t = newTracked();
  assert.equal(applyCheck(t, 'RUNNING', 0, svc), undefined);
  assert.equal(applyCheck(t, 'STOPPED', 1000, svc), undefined); // одна проверка — ещё не тревога
  assert.equal(applyCheck(t, 'RUNNING', 2000, svc), undefined); // мигнула и вернулась — без уведомлений
  assert.equal(applyCheck(t, 'STOPPED', 3000, svc), undefined);
  const down = applyCheck(t, 'STOPPED', 4000, svc);
  assert.equal(down?.kind, 'down');
  assert.equal(down?.at, 3000);
  assert.equal(applyCheck(t, 'STOPPED', 5000, svc), undefined); // повторных тревог нет
  assert.equal(applyCheck(t, 'RUNNING', 6000, svc), undefined);
  const up = applyCheck(t, 'RUNNING', 7000, svc);
  assert.equal(up?.kind, 'up');
  assert.ok(up?.kind === 'up' && up.downSince === 3000 && up.at === 6000);
});

test('ServiceStore: перенос из config.json, добавление, удаление, сохранение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsm-'));
  const seed = path.join(dir, 'config.json');
  fs.writeFileSync(seed, JSON.stringify({ services: [{ label: 'QUIK Server', name: 'QuikServerQ' }, { label: 'bad', name: 'a b' }] }));
  const file = path.join(dir, 'data', 'services.json');

  const store = new ServiceStore(file, seed);
  assert.deepEqual(store.list(), [{ name: 'QuikServerQ', label: 'QUIK Server' }]);
  assert.equal(store.add({ name: 'quikserverq', label: 'дубль' }), false);
  assert.equal(store.add({ name: 'Spooler', label: 'Печать' }), true);
  assert.equal(store.remove('QUIKSERVERQ')?.name, 'QuikServerQ');
  assert.equal(store.remove('нет такой'), undefined);

  // после перезапуска список читается из services.json, config.json больше не используется
  fs.writeFileSync(seed, JSON.stringify({ services: [] }));
  assert.deepEqual(new ServiceStore(file, seed).list(), [{ name: 'Spooler', label: 'Печать' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatTransition: экранирование HTML и длительность простоя', () => {
  assert.equal(esc('<a&b>'), '&lt;a&amp;b&gt;');
  const text = formatTransition({ kind: 'up', service: { name: 'S', label: '<x>' }, at: 125_000, downSince: 0 }, 'Srv', 'Asia/Bishkek');
  assert.match(text, /&lt;x&gt;/);
  assert.match(text, /Простой: 2 мин 5 с/);
});
