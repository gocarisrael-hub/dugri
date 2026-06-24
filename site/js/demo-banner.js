// Single source for the "site in beta / payment not live" demo banner.
// Included on the flow pages; remove this one file + the <script> tags when
// real payment goes live.
(function () {
  var bar = document.createElement('div');
  bar.className = 'dugri-demo-banner';
  bar.textContent = '🛠️ אתר בהרצה · התשלום עדיין לא פעיל (הדגמה) — אפשר להתנסות בכל התהליך';
  bar.setAttribute(
    'style',
    'background:#2c1a29;color:#fff;text-align:center;font-size:12px;font-weight:600;padding:2px 12px'
  );
  document.body.insertBefore(bar, document.body.firstChild);
})();
