/* Shared enquiry form for inner pages: Cloudflare function to GoHighLevel,
   then the thank you page. Same events as the homepage form. */
(function(){
  var f=document.getElementById('lead-form-el');if(!f)return;
  var st=f.querySelector('.xlead-status'),btn=f.querySelector('button[type=submit]'),label=btn.textContent;
  f.addEventListener('submit',function(e){
    e.preventDefault();btn.disabled=true;btn.textContent='Sending…';st.textContent='';
    var p={'form-name':'enquiry',page:location.pathname};new FormData(f).forEach(function(v,k){p[k]=String(v)});
    fetch('/api/enquiry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})
      .then(function(r){if(!r.ok)throw 0;
        try{(window.dataLayer=window.dataLayer||[]).push({event:'enquiry_submit',form_name:'enquiry',page_location:location.href});
          window.fbq&&fbq('track','Lead',{content_name:'enquiry-form',content_category:'enquiry'})}catch(_){}
        st.textContent='Thanks, that has landed.';
        setTimeout(function(){location.href='/thank-you?type=enquiry'},600)})
      .catch(function(){btn.disabled=false;btn.textContent=label;
        st.innerHTML='That did not send. Email <a href="mailto:alex@elevatexsolutions.co.uk">alex@elevatexsolutions.co.uk</a> and it will reach Alex directly.'});
  });
})();
