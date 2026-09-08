// Shared "động viên" pop-up shown after finishing any mini game.
// Usage: include this file, then call showCheer() when a reward lands.
(function(){
  const LINES = [
    'Chơi xong rồi, giờ mở laptop lên "chơi" tiếp với deadline nhé! 💻',
    'Nạp đủ vía may mắn — hôm nay meeting nào cũng cân hết! 💪',
    'Lửa đã có, năng lượng đã đầy, đi bào KPI thôi nào! 🔥',
    'Bạn vừa xả stress hợp lệ trong giờ làm. Sếp không biết đâu 🤫',
    'Trung Thu vui vẻ! Nhớ là cà phê chưa uống thì đừng nhận task gấp nha ☕',
    'Xong! Giờ giả vờ bận rộn thêm 5 phút rồi hẵng làm việc 😎',
    'Chúc bạn một ngày ít email, nhiều bánh, không ai gọi họp gấp! 🥮',
    'Bạn xứng đáng được nghỉ tay — à mà nghỉ xong nhớ làm việc lại nhé 🌙',
    'Đủ lửa rồi đó! Đem nhiệt huyết này đi "chốt" nốt việc còn dang dở 🏮',
    'Hôm nay bạn đã làm 1 việc có ích: chơi game. Việc còn lại tính sau 🎉',
    'Vui lên nào! Cuối tháng lương về, cuối năm thưởng về (chắc vậy) 🧧',
    'Nghỉ giải lao xong, chiến tiếp! Chú Cuội cũng đang cày trên cung trăng kìa 🌕',
    'Bạn vừa +EXP tinh thần. Giờ đi apply cho công việc thật nhé! ✨',
    'Thở sâu, cười tươi, và... mở lại cái tab công việc vừa ẩn đi 😅',
    'Chúc bạn deadline nào cũng "nhẹ như bánh dẻo" 🎐',
  ];

  function ensureStyle(){
    if (document.getElementById('cheerStyle')) return;
    const st = document.createElement('style'); st.id = 'cheerStyle';
    st.textContent = `
      .cheerWrap{ position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center;
        background:rgba(5,3,20,.55); backdrop-filter:blur(3px); animation:cheerFade .25s ease; }
      .cheerCard{ position:relative; width:min(88vw,360px); text-align:center; color:#5a3a12;
        background:linear-gradient(180deg,#fff8ea,#ffe7c2); border:2px solid #ffd77a; border-radius:22px;
        padding:26px 22px 20px; box-shadow:0 20px 50px rgba(0,0,0,.5); animation:cheerPop .45s cubic-bezier(.2,.9,.3,1.3); }
      .cheerCard .em{ font-size:52px; filter:drop-shadow(0 4px 10px rgba(0,0,0,.2)); }
      .cheerCard .msg{ font-size:17px; font-weight:800; line-height:1.5; margin:10px 4px 18px; }
      .cheerCard .ok{ border:none; cursor:pointer; font-size:16px; font-weight:800; color:#fff;
        padding:12px 34px; border-radius:999px; background:radial-gradient(circle at 50% 26%,#ffa63d,#ff8c1a 40%,#b5340c);
        box-shadow:0 6px 18px rgba(255,120,20,.5); }
      .cheerCard .ok:active{ transform:scale(.95); }
      @keyframes cheerFade{ from{opacity:0} to{opacity:1} }
      @keyframes cheerPop{ 0%{transform:scale(.6);opacity:0} 60%{transform:scale(1.06)} 100%{transform:scale(1);opacity:1} }`;
    document.head.appendChild(st);
  }

  // showCheer({delay}) — pops a random encouragement. Safe to call once per game end.
  window.showCheer = function(opts){
    opts = opts || {};
    ensureStyle();
    const run = ()=>{
      if (document.querySelector('.cheerWrap')) return;   // don't stack
      const wrap = document.createElement('div'); wrap.className = 'cheerWrap';
      const line = LINES[Math.floor(Math.random()*LINES.length)];
      const card = document.createElement('div'); card.className = 'cheerCard';
      const em = document.createElement('div'); em.className='em'; em.textContent='🌟';
      const msg = document.createElement('div'); msg.className='msg'; msg.textContent = line;
      const btn = document.createElement('button'); btn.className='ok'; btn.textContent='Về trang chính 🏠';
      card.appendChild(em); card.appendChild(msg); card.appendChild(btn);
      wrap.appendChild(card); document.body.appendChild(wrap);
      // after reading the message, go back to the hub (main page)
      const dest = opts.back || '/hub';
      const go = ()=>{ wrap.remove(); location.href = dest; };
      btn.addEventListener('click', go);
      wrap.addEventListener('click', e=>{ if(e.target===wrap) go(); });
    };
    if (opts.delay) setTimeout(run, opts.delay); else run();
  };
})();
