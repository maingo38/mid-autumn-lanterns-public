// Shared "động viên" pop-up shown after finishing any mini game.
// Usage: include this file, then call showCheer() when a reward lands.
(function(){
  const LINES = [
    // cà khịa công sở
    'Chơi xong rồi, giờ mở laptop lên "chơi" tiếp với deadline nhé! 💻',
    'Nạp đủ vía may mắn — hôm nay meeting nào cũng cân hết! 💪',
    'Lửa đã có, năng lượng đã đầy, đi bào KPI thôi nào! 🔥',
    'Bạn vừa xả stress hợp lệ trong giờ làm. Sếp không biết đâu 🤫',
    'Xong! Giờ giả vờ bận rộn thêm 5 phút rồi hẵng làm việc 😎',
    'Đủ lửa rồi đó! Đem nhiệt huyết này đi "chốt" nốt việc dang dở 🏮',
    'Hôm nay bạn đã làm 1 việc có ích: chơi game. Việc kia tính sau 🎉',
    'Thở sâu, cười tươi, và... mở lại cái tab công việc vừa ẩn đi 😅',
    'Report chưa xong nhưng tinh thần đã xong. Ổn! 📊',
    'Sếp hỏi "đang làm gì đó?" — bảo "đang nạp năng lượng sáng tạo" 🧠',
    'Họp 3 tiếng không bằng chơi 3 phút. Nhưng thôi, đi họp đi 🥲',
    'Deadline gần kề? Kệ, Trung Thu mà, xơi miếng bánh đã 🥮',
    'Bạn của tháng này: người vừa chơi game xong. Chính là bạn 🏆',
    'Inbox có 47 mail chưa đọc. Nhưng giờ là giờ của bạn ✨',
    'Làm hết mình, chơi hết lửa. Cân bằng cuộc sống là đây chứ đâu ⚖️',
    // dễ thương / Trung Thu
    'Chúc bạn một ngày ít email, nhiều bánh, không ai gọi họp gấp! 🥮',
    'Bạn xứng đáng được nghỉ tay — nghỉ xong nhớ làm việc lại nhé 🌙',
    'Vui lên nào! Cuối tháng lương về, cuối năm thưởng về (chắc vậy) 🧧',
    'Chú Cuội cũng đang cày trên cung trăng kìa — mình cố nốt nhé 🌕',
    'Chúc bạn deadline nào cũng "nhẹ như bánh dẻo" 🎐',
    'Trăng tròn, lòng an, việc gì rồi cũng xong thôi 🌕',
    'Chị Hằng gửi lời chúc: hôm nay của bạn thật nhiều tiếng cười 💛',
    'Thỏ Ngọc chúc bạn nhảy việc... à nhầm, nhảy qua deadline nhẹ nhàng 🐰',
    'Một miếng bánh, một ngụm trà, một ngày an lành nha 🍵',
    'Đèn lồng của bạn đang sáng trên bầu trời rồi đó — ngước lên xem nhé 🏮',
    // tạo động lực (xàm mà vui)
    'Bạn vừa +10 EXP tinh thần. Level up! Giờ đi cày tiếp 🎮',
    'Tin vui: bạn giỏi game. Tin buồn: việc vẫn ở đó. Cân cả hai nào 💪',
    'Nghiên cứu cho thấy: người chơi game xong làm việc vui hơn. (Mình bịa) 🤓',
    'Sạc pin tinh thần: 100%. Đủ dùng tới giờ tan làm 🔋',
    'Vũ trụ đã ghi nhận sự cố gắng của bạn hôm nay ✨',
    'Hôm nay bạn toả sáng như đèn lồng — đừng để ai tắt nhé 🏮',
    'Cười một cái coi! Ngày dài nhưng bạn dài hơi hơn 😄',
    'Bạn làm được! (câu này áp dụng cho cả deadline lẫn miếng bánh cuối) 🥮',
    'Giữ vibe này nha — mang qua cuộc họp tiếp theo luôn 🎊',
    'Xong game, xong lo. Việc còn lại chỉ là chuyện nhỏ 🌟',
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
