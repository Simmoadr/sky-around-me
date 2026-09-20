// SKY AROUND ME BACKEND — STABLE BUILD 2026-09-19
// Defensive no-op trace prevents a diagnostic call from ever breaking a live lookup.
function trace(){ }

const ALLOWED_ORIGINS = new Set([
  "https://simmodair.github.io",
  "https://simmoadr.github.io",
  "https://magenta-syrniki-2f4749.netlify.app"
]);

function corsHeadersFor(request) {
  const origin = String(request?.headers?.get("Origin") || "");
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Cache-Control": "no-store"
  };
}

function json(data, status=200, extraHeaders={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

// Warm-instance caches deliberately keep enrichment requests tiny. Live traffic
// can refresh frequently, but a selected aircraft identity/route does not need
// to be looked up every 45 seconds.
let liveCached = null;
let liveInFlight = null;
const LIVE_CACHE_MS = 20000;
const lookupCache = new Map();
const lookupInFlight = new Map();
const LOOKUP_CACHE_MS = 120000;

async function skyAroundMeRequest(request) {
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:corsHeadersFor(request)});
  if (request.method !== "GET") return json({ok:false,error:"Method not allowed"},405);

  const u = new URL(request.url);
  const lookup = String(u.searchParams.get("lookup") || "").toLowerCase();
  if (lookup === "callsign") return handleCallsignLookup(u.searchParams.get("value"), u.searchParams.get("registration"));
  if (lookup === "live") return handleLiveLookup(u.searchParams.get("callsign"));
  if (lookup === "identity") return handleIdentityLookup(u.searchParams.get("callsign"), u.searchParams.get("registration"), u.searchParams.get("from"), u.searchParams.get("to"), u.searchParams.get("date"), u.searchParams.get("debug"));
  if (lookup === "schedule") return handleWatchedSchedule(u.searchParams.get("flight"), u.searchParams.get("date"));
  if (lookup === "flight") return handleWatchedFlight(u.searchParams.get("flight"), u.searchParams.get("date"));
  if (lookup) return json({ok:false,error:"Unsupported lookup"},400);

  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const distKm = Number(u.searchParams.get("dist"));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(distKm)||lat < -90||lat > 90||lon < -180||lon > 180||distKm <= 0)
    return json({ok:false,error:"Invalid parameters"},400);

  const radiusNm = Math.min(135, Math.max(5, distKm/1.852));
  const key = `${lat.toFixed(3)}|${lon.toFixed(3)}|${radiusNm.toFixed(1)}`;
  const now = Date.now();
  if(liveCached && liveCached.key===key && now-liveCached.time<LIVE_CACHE_MS) return json(liveCached.payload,200,{"X-SkyAroundMe-Cache":"HIT"});
  if(liveInFlight && liveInFlight.key===key) return liveInFlight.promise;

  // ADSB.fi v3 is the current public point endpoint. Airplanes.live and
  // ADSB.lol remain fallbacks if the first source is temporarily unavailable.
  const sources = [
    {name:"ADSB.fi", url:`https://opendata.adsb.fi/api/v3/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radiusNm.toFixed(1)}`},
    {name:"Airplanes.live", url:`https://api.airplanes.live/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${radiusNm.toFixed(1)}`},
    {name:"ADSB.lol", url:`https://api.adsb.lol/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${radiusNm.toFixed(1)}`}
  ];

  const promise = runSources(sources,key);
  liveInFlight={key,promise};
  try{return await promise} finally {if(liveInFlight?.promise===promise) liveInFlight=null;}
};


async function fetchJsonSource(source){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const r=await fetch(source.url,{method:"GET",headers:{Accept:"application/json","User-Agent":"Sky-Around-Me/1.0"},signal:controller.signal});
    const text=await r.text();
    let payload=null;
    try{payload=JSON.parse(text)}catch{}
    if(!r.ok) return {ok:false,status:r.status,error:`HTTP ${r.status}`,payload:null};
    if(!payload||!Array.isArray(payload.ac)) return {ok:false,status:r.status,error:"Invalid aircraft response",payload};
    return {ok:true,status:r.status,error:"",payload};
  }catch(e){
    return {ok:false,status:0,error:String(e?.message||e),payload:null};
  }finally{clearTimeout(timer)}
}

async function runSources(sources,key){
  const errors=[];
  for(const source of sources){
    const result=await fetchJsonSource(source);
    if(result.ok){
      const payload={
        ...result.payload,
        _skyProvider:source.name,
        _skySource:source.name,
        _skyStatus:result.status,
        _skyErrors:errors
      };
      liveCached={key,time:Date.now(),payload};
      return json(payload,200,{"X-SkyAroundMe-Source":source.name});
    }
    errors.push({source:source.name,status:result.status,error:result.error});
  }
  const payload={
    ac:[],
    _skyProvider:"UNAVAILABLE",
    _skySource:"UNAVAILABLE",
    _skyStatus:502,
    _skyErrors:errors,
    error:"All live aircraft sources failed"
  };
  liveCached={key,time:Date.now(),payload};
  return json(payload,502,{"X-SkyAroundMe-Source":"UNAVAILABLE"});
}


async function handleLiveLookup(value){
  const callsign=String(value||"").trim().toUpperCase().replace(/\s+/g,"");
  if(!/^[A-Z0-9]{3,10}$/.test(callsign)) return json({ok:false,error:"Invalid callsign"},400);
  const cacheKey=`live|${callsign}`;
  const now=Date.now();
  const cached=lookupCache.get(cacheKey);
  if(cached && now-cached.time<30000) return json(cached.payload,200,{"X-SkyAroundMe-Lookup-Cache":"HIT"});
  if(lookupInFlight.has(cacheKey)) return lookupInFlight.get(cacheKey);
  const promise=(async()=>{
    const sources=[
      {name:"ADSB.fi",url:`https://opendata.adsb.fi/api/v2/callsign/${encodeURIComponent(callsign)}`},
      {name:"ADSB One",url:`https://api.adsb.one/v2/callsign/${encodeURIComponent(callsign)}`}
    ];
    for(const source of sources){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),10000);
      try{
        const r=await fetch(source.url,{method:"GET",headers:{Accept:"application/json","User-Agent":"Sky-Around-Me/1.0"},signal:controller.signal});
        const body=await r.text();
        if(!r.ok) continue;
        let payload;try{payload=JSON.parse(body)}catch{continue}
        if(!Array.isArray(payload?.ac)||!payload.ac.length) continue;
        const out={ac:payload.ac,_skyProvider:source.name,_skyLookup:callsign};
        lookupCache.set(cacheKey,{time:Date.now(),payload:out});
        return json(out,200,{"X-SkyAroundMe-Lookup":source.name});
      }catch(e){} finally{clearTimeout(timer)}
    }
    const out={ac:[],_skyProvider:"UNAVAILABLE",_skyLookup:callsign};
    lookupCache.set(cacheKey,{time:Date.now(),payload:out});
    return json(out,200,{"X-SkyAroundMe-Lookup":"NOT_FOUND"});
  })();
  lookupInFlight.set(cacheKey,promise);
  try{return await promise} finally{lookupInFlight.delete(cacheKey)}
}

async function handleIdentityLookup(callsignValue, registrationValue, fromValue, toValue, dateValue, debugValue){
  const callsign=String(callsignValue||"").trim().toUpperCase().replace(/\s+/g,"");
  const registration=String(registrationValue||"").trim().toUpperCase().replace(/\s+/g,"");
  const suppliedFrom=String(fromValue||"").trim().toUpperCase();
  const suppliedTo=String(toValue||"").trim().toUpperCase();
  const hasSuppliedRoute=/^[A-Z]{3}$/.test(suppliedFrom)&&/^[A-Z]{3}$/.test(suppliedTo);
  const requestedDate=watchValidDate(String(dateValue||""))?String(dateValue):new Date().toISOString().slice(0,10);
  const debug=String(debugValue||"") === "1";
  const debugTrace=[];
  const trace=(stage,status,data={})=>{ if(debug) debugTrace.push({stage,status,...data}); };
  trace("INPUT","OK",{callsign,registration,from:suppliedFrom,to:suppliedTo,date:requestedDate,hasSuppliedRoute});
  if(!callsign && !registration){ trace("VALIDATION","ERROR",{reason:"Missing callsign/registration"}); return json({ok:false,error:"Missing callsign/registration",_skyDebug:debugTrace},400); }
  if(!hasSuppliedRoute){ trace("VALIDATION","ERROR",{reason:"Origin and destination required",from:suppliedFrom,to:suppliedTo}); return json({ok:true,flightroute:null,flightNumber:"",status:"UNVERIFIED",_skyProvider:"UNVERIFIED",_skyLookup:callsign||registration,_skyEvidence:"Origin and destination required for identity resolution",_skyRoute:"",_skyDebug:debugTrace},200); }
  const cacheKey=`identity-v6|${callsign}|${registration}|${suppliedFrom}|${suppliedTo}|${requestedDate}`;
  const now=Date.now();
  const cached=lookupCache.get(cacheKey);
  if(cached && now-cached.time<LOOKUP_CACHE_MS && !debug){ trace("CACHE","HIT",{key:cacheKey}); return json(cached.payload,200,{"X-SkyAroundMe-Lookup-Cache":"HIT"}); }
  if(cached && debug) trace("CACHE","BYPASS",{reason:"debug=1"});
  if(lookupInFlight.has(cacheKey)) return lookupInFlight.get(cacheKey);

  const promise=(async()=>{
    let pfFlightNumber="";
    let pfSource="";
    let pfEvidence="";

    // FIRST: resolve the ADS-B callsign through Plane Finder's own flight page.
    // We do not convert an ICAO callsign ourselves. The passenger flight number
    // must be explicitly presented by Plane Finder alongside the supplied callsign.
    if(callsign){
      try{
        const url=`https://planefinder.net/data/flight/${encodeURIComponent(callsign)}?sky=${Date.now()}`;
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),10000);
        try{
          const r=await fetch(url,{headers:{Accept:"text/html,application/xhtml+xml", "User-Agent":"Sky-Around-Me/1.0"},signal:controller.signal});
          trace("PLANE_FINDER_CALLSIGN",r.ok?"HTTP_OK":"HTTP_ERROR",{status:r.status,url});
          if(r.ok){
            const html=await r.text();
            const clean=String(html)
              .replace(/<script[\s\S]*?<\/script>/gi,' ')
              .replace(/<style[\s\S]*?<\/style>/gi,' ')
              .replace(/<[^>]+>/g,' ')
              .replace(/&nbsp;/gi,' ')
              .replace(/&amp;/gi,'&')
              .replace(/\s+/g,' ')
              .trim();

            const re1=new RegExp(String.raw`(?:Flight|flight)\s+([A-Z]{1,3}\d{2,5}[A-Z]?)\s+${callsign}\b`,'i');
            const re2=new RegExp(String.raw`(?:Flight|flight)\s+([A-Z]{1,3}\d{2,5}[A-Z]?)\b[\s\S]{0,80}\b${callsign}\b`,'i');
            const m=clean.match(re1)||clean.match(re2);
            if(m) pfFlightNumber=String(m[1]).toUpperCase();

            if(!pfFlightNumber){
              const rawRe=new RegExp(String.raw`(?:Flight|flight)\s+([A-Z]{1,3}\d{2,5}[A-Z]?)\b[\s\S]{0,180}\b${callsign}\b`,'i');
              const raw=String(html).match(rawRe);
              if(raw) pfFlightNumber=String(raw[1]).toUpperCase();
            }
            trace("PLANE_FINDER_CALLSIGN","PARSED",{flightNumber:pfFlightNumber||"",note:hasSuppliedRoute?"Route supplied, callsign-page number intentionally ignored until route is proven":"No route supplied"});
            if(pfFlightNumber && !hasSuppliedRoute){pfSource="PlaneFinder callsign page";pfEvidence=callsign;} else if(hasSuppliedRoute){pfFlightNumber="";}
          }
        } finally { clearTimeout(timer); }
      }catch(e){ trace("PLANE_FINDER_CALLSIGN","EXCEPTION",{name:e?.name||"",message:e?.message||String(e)}); }
    }

    // SECOND: resolve from the exact aircraft registration + supplied route.
    // Do NOT take the first flight listed on a registration page: an aircraft
    // can operate multiple sectors on the same day (for example RK6480/RK6481
    // or BY2622/BY2623). The route is the selector.
    //
    // We deliberately do NOT use Plane Finder's registration page as a blind
    // fallback here because its "live" section can expose a flight without
    // enough route/registration context to prove that it is the supplied sector.
    // Flightradar24's aircraft history gives us the exact date + route pairing.

    // THIRD: Flightradar24 public aircraft history. This is registration-based
    // and route-aware; it does not manufacture a passenger flight number from
    // the ADS-B callsign.
    let frFlightNumber="";
    if(registration){
      try{
        const url=`https://www.flightradar24.com/data/aircraft/${encodeURIComponent(registration.toLowerCase())}?sky=${Date.now()}`;
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),10000);
        try{
          const r=await fetch(url,{headers:{Accept:"text/html,application/xhtml+xml", "User-Agent":"Sky-Around-Me/1.0"},signal:controller.signal});
          trace("FLIGHTRADAR24_REGISTRATION",r.ok?"HTTP_OK":"HTTP_ERROR",{status:r.status,url});
          if(r.ok){
            const html=await r.text();
            const clean=watchStripHtml(html);
            const parts=requestedDate.split("-").map(Number);
            const day=String(parts[2]);
            const month=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parts[1]-1];
            const year=String(parts[0]);
            const dateLabel=`${day} ${month} ${year}`;
            const escapedDate=dateLabel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            const rowRe=new RegExp(String.raw`\b([A-Z]{1,3}\d{2,5}[A-Z]?)\s+${escapedDate}[\s\S]{0,320}?FROM\s+[^()]{0,120}\(([A-Z]{3})\)\s+TO\s+[^()]{0,120}\(([A-Z]{3})\)`,'gi');
            const rows=[...clean.matchAll(rowRe)].map(m=>({flight:String(m[1]).toUpperCase(),from:String(m[2]).toUpperCase(),to:String(m[3]).toUpperCase()}));
            trace("FLIGHTRADAR24_REGISTRATION","ROWS_PARSED",{dateLabel,requestedRoute:`${suppliedFrom}-${suppliedTo}`,rowCount:rows.length,rows:rows.slice(0,20)});

            // STRICT RULE: exact route match only. Never fall back to rows[0].
            const chosen=rows.find(x=>x.from===suppliedFrom && x.to===suppliedTo);
            if(chosen){
              trace("FLIGHTRADAR24_REGISTRATION","EXACT_ROUTE_MATCH",{flight:chosen.flight,from:chosen.from,to:chosen.to});
              frFlightNumber=chosen.flight;
              pfFlightNumber=frFlightNumber;
              pfSource="Flightradar24 registration history";
              pfEvidence=`${registration} ${dateLabel} ${chosen.from}-${chosen.to}`;
            } else { trace("FLIGHTRADAR24_REGISTRATION","NO_EXACT_ROUTE_MATCH",{requestedRoute:`${suppliedFrom}-${suppliedTo}`}); }
          }
        } finally { clearTimeout(timer); }
      }catch(e){ trace("FLIGHTRADAR24_REGISTRATION","EXCEPTION",{name:e?.name||"",message:e?.message||String(e)}); }
    }

    // FALLBACK: AirNav Radar exposes a registration history that includes the\n    // passenger flight number, ADS-B callsign and route together. This is exactly\n    // the evidence we need when Plane Finder / FR24 block server-side requests.\n    // We still require an exact callsign + exact route match, so we never guess\n    // a flight number from the callsign alone.\n    if(!pfFlightNumber && registration && callsign){\n      try{\n        const url=`https://www.airnavradar.com/data/registration/${encodeURIComponent(registration)}`;\n        const controller=new AbortController();\n        const timer=setTimeout(()=>controller.abort(),10000);\n        try{\n          const r=await fetch(url,{headers:{Accept:"text/html,application/xhtml+xml", "User-Agent":"Sky-Around-Me/1.0"},signal:controller.signal});\n          trace("AIRNAVRADAR_REGISTRATION",r.ok?"HTTP_OK":"HTTP_ERROR",{status:r.status,url});\n          if(r.ok){\n            const html=await r.text();\n            const clean=html.replace(/<script[\\s\\S]*?<\\/script>/gi," ").replace(/<style[\\s\\S]*?<\\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\\s+/g," ").trim();\n            const csEsc=callsign.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\$&");\n            const rowRe=new RegExp(`(?:^|\\s)([A-Z0-9]{2,7})\\s*[/|]\\s*${csEsc}(?=[\\s\\S]{0,600})`,'i');\n            const m=clean.match(rowRe);\n            if(m){\n              const windowStart=Math.max(0,(m.index||0)-180);\n              const windowText=clean.slice(windowStart,Math.min(clean.length,(m.index||0)+900));\n              const routeRe=/\\b([A-Z]{3})\\b[^A-Z0-9]{0,80}\\b([A-Z]{3})\\b/;\n              const routeMatches=[...windowText.matchAll(routeRe)];\n              let matchedRoute=false;\n              for(const rm of routeMatches){\n                const r1=rm[1].toUpperCase(),r2=rm[2].toUpperCase();\n                if(r1===suppliedFrom && r2===suppliedTo){\n                  matchedRoute=true;break;\n                }\n              }\n              const candidate=String(m[1]||'').toUpperCase();\n              const validFlight=/^[A-Z0-9]{2,3}\\d{1,4}$/.test(candidate);\n              trace("AIRNAVRADAR_REGISTRATION",matchedRoute&&validFlight?"EXACT_ROUTE_MATCH":"NO_EXACT_ROUTE_MATCH",{candidate,callsign,requestedRoute:`${suppliedFrom}-${suppliedTo}`,matchedRoute,validFlight});\n              if(matchedRoute&&validFlight){\n                pfFlightNumber=candidate;\n                pfSource="AirNav Radar registration history";\n                pfEvidence=`${registration} ${callsign} ${suppliedFrom}-${suppliedTo}`;\n              }\n            }else{\n              trace("AIRNAVRADAR_REGISTRATION","CALLSIGN_NOT_FOUND",{callsign,registration});\n            }\n          }\n        } finally { clearTimeout(timer); }\n      }catch(e){ trace("AIRNAVRADAR_REGISTRATION","EXCEPTION",{name:e?.name||"",message:e?.message||String(e)}); }\n    }\n\n    // ADSBdb can provide the commercial IATA flight number. We only
    // promote it when the supplied route exactly matches ADSBdb AND the
    // value has a normal commercial format: 2-3 letters + digits only.
    // This rejects callsign-derived values such as U273EH, while accepting
    // genuine values such as UA932 for UAL932.
    let fr=null;
    if(callsign){
      try{
        const url=`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`;
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),10000);
        try{
          const r=await fetch(url,{method:"GET",headers:{Accept:"application/json","User-Agent":"Sky-Around-Me/1.0"},signal:controller.signal});
          trace("ADSBDB_ROUTE",r.ok?"HTTP_OK":"HTTP_ERROR",{status:r.status,url});
          if(r.ok){
            const payload=await r.json();
            fr=payload?.response?.flightroute||null;
            const originCode=String(fr?.origin?.iata_code||"").toUpperCase();
            const destinationCode=String(fr?.destination?.iata_code||"").toUpperCase();
            const callsignIata=String(fr?.callsign_iata||"").toUpperCase().replace(/\s+/g,"");
            trace("ADSBDB_ROUTE","PARSED",{found:!!fr,origin:originCode,destination:destinationCode,callsignIata});
            const validCommercialFlight=/^[A-Z]{2,3}\d{1,4}$/.test(callsignIata);
            const exactRoute=hasSuppliedRoute && originCode===suppliedFrom && destinationCode===suppliedTo;
            if(callsignIata && validCommercialFlight && exactRoute && !pfFlightNumber){
              pfFlightNumber=callsignIata;
              pfSource="ADSBdb exact-route flight number";
              pfEvidence=`${callsign} ${registration||""} ${suppliedFrom}-${suppliedTo} ${callsignIata}`.trim();
              trace("ADSBDB_ROUTE","EXACT_ROUTE_FLIGHT_NUMBER_ACCEPTED",{flightNumber:callsignIata,route:`${suppliedFrom}-${suppliedTo}`});
            }else{
              trace("ADSBDB_ROUTE","FLIGHT_NUMBER_NOT_ACCEPTED",{callsignIata,validCommercialFlight,exactRoute,route:hasSuppliedRoute?`${suppliedFrom}-${suppliedTo}`:""});
            }
          }
        } finally { clearTimeout(timer); }
      }catch(e){ trace("ADSBDB_ROUTE","EXCEPTION",{name:e?.name||"",message:e?.message||String(e)}); }
    }


    const resolvedRoute = hasSuppliedRoute
      ? {...(fr||{}),origin:{...((fr&&fr.origin)||{}),iata_code:suppliedFrom},destination:{...((fr&&fr.destination)||{}),iata_code:suppliedTo}}
      : fr;
    const out={
      flightroute:resolvedRoute,
      flightNumber:pfFlightNumber,
      status:pfFlightNumber?"FOUND":"UNVERIFIED",
      _skyProvider:pfFlightNumber?pfSource:"UNVERIFIED",
      _skyLookup:callsign||registration,
      _skyEvidence:pfEvidence,
      _skyRoute:hasSuppliedRoute?`${suppliedFrom}-${suppliedTo}`:"",
      _skyDebug:debug?debugTrace:undefined
    };
    trace(out.flightNumber?"FINAL":"FINAL_UNVERIFIED",out.flightNumber?"FOUND":"UNVERIFIED",{flightNumber:out.flightNumber||"",provider:out._skyProvider,route:out._skyRoute,evidence:out._skyEvidence||""});
    out._skyDebug=debug?debugTrace:undefined;
    lookupCache.set(cacheKey,{time:Date.now(),payload:out});
    return json(out,200,{"X-SkyAroundMe-Lookup":out.flightNumber?out._skyProvider:"UNVERIFIED"});
  })();
  lookupInFlight.set(cacheKey,promise);
  try{return await promise} finally{lookupInFlight.delete(cacheKey);}
}

async function handleCallsignLookup(value, registration){
  const callsign=String(value||"").trim().toUpperCase().replace(/\s+/g,"");
  const reg=String(registration||"").trim().toUpperCase().replace(/\s+/g,"");
  if(!/^[A-Z0-9]{3,10}$/.test(callsign)) return json({ok:false,error:"Invalid callsign"},400);

  const cacheKey=`callsign|${callsign}|${reg}`;
  const now=Date.now();
  const cached=lookupCache.get(cacheKey);
  if(cached && now-cached.time<LOOKUP_CACHE_MS) return json(cached.payload,200,{"X-SkyAroundMe-Lookup-Cache":"HIT"});
  if(lookupInFlight.has(cacheKey)) return lookupInFlight.get(cacheKey);

  const promise=(async()=>{
    const key=String(process.env.AIRLABS_API_KEY||"").trim();
    let airLabsError="";
    let fr=null;

    // First get the actual ADS-B route/airline. This is deliberately used as
    // context only; ADSBdb's callsign_iata can be derived from the callsign and
    // is therefore NOT promoted to a passenger flight number here.
    try{
      const url=`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`;
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),10000);
      try{
        const r=await fetch(url,{method:"GET",headers:{Accept:"application/json","User-Agent":"Sky-Around-Me/1.0"},signal:controller.signal});
        if(r.ok){
          const payload=await r.json();
          fr=payload?.response?.flightroute||null;
        }
      }finally{clearTimeout(timer)}
    }catch(e){ }

    if(key){
      try{
        // IMPORTANT: an ADS-B broadcast callsign such as EZY16AT is not
        // necessarily the same identifier as AirLabs' flight_icao. AirLabs'
        // flight_icao lookup expects an ICAO flight code such as EZY2719.
        // For an aircraft-centric resolver, the registration is the strongest
        // bridge: ask AirLabs for the live aircraft by registration and take
        // the flight number it associates with that aircraft.
        let row=null;
        let upstreamStatus=null;
        const urls=[];
        if(reg) urls.push(`https://airlabs.co/api/v9/flights?reg_number=${encodeURIComponent(reg)}&api_key=${encodeURIComponent(key)}`);

        // If registration is unavailable, use the ADS-B route + airline as a
        // constrained live search. Never select an arbitrary row when there
        // are multiple candidates.
        const airlineIata=String(fr?.airline?.iata||"").trim().toUpperCase();
        const from=String(fr?.origin?.iata_code||"").trim().toUpperCase();
        const to=String(fr?.destination?.iata_code||"").trim().toUpperCase();
        if(airlineIata && from && to){
          urls.push(`https://airlabs.co/api/v9/flights?airline_iata=${encodeURIComponent(airlineIata)}&dep_iata=${encodeURIComponent(from)}&arr_iata=${encodeURIComponent(to)}&api_key=${encodeURIComponent(key)}`);
        }

        let lastError="";
        for(const url of urls){
          const controller=new AbortController();
          const timer=setTimeout(()=>controller.abort(),10000);
          try{
            const r=await fetch(url,{method:"GET",headers:{Accept:"application/json"},signal:controller.signal});
            upstreamStatus=r.status;
            const text=await r.text();
            let payload=null;try{payload=JSON.parse(text)}catch{}
            if(!r.ok){lastError=`AirLabs HTTP ${r.status}`;continue;}
            if(payload?.error){lastError=String(payload.error.message||payload.error||"AirLabs error");continue;}
            const rows=Array.isArray(payload?.response)?payload.response:(Array.isArray(payload?.data)?payload.data:[]);
            if(!rows.length){lastError="AirLabs returned no matching live aircraft";continue;}

            if(reg){
              row=rows.find(x=>String(x?.reg_number||x?.registration||"").trim().toUpperCase()===reg)||null;
            }
            if(!row && !reg && rows.length===1) row=rows[0];
            if(row)break;
            lastError=reg?"AirLabs returned live data but not for the requested registration":"AirLabs returned multiple route candidates";
          }catch(e){lastError=String(e?.message||e)}
          finally{clearTimeout(timer)}
        }

        if(row){
          const flightNumber=String(row.flight_iata||row.flight_number||"").trim().toUpperCase();
          let adsbMatch=null;
          if(row.hex){
            try{
              const liveRows=await adsbByHex(row.hex);
              adsbMatch=liveRows.find(a=>String(a?.hex||"").trim().toUpperCase()===String(row.hex||"").trim().toUpperCase())||liveRows[0]||null;
            }catch(e){}
          }
          const rowReg=String(row.reg_number||row.registration||reg).trim().toUpperCase();
          const rowHex=String(row.hex||row.aircraft_hex||"").trim().toUpperCase();
          const fromCode=String(row.dep_iata||from||"").trim().toUpperCase();
          const toCode=String(row.arr_iata||to||"").trim().toUpperCase();
          const airlineName=String(row.airline_name||fr?.airline?.name||"").trim();
          const airlineIataRow=String(row.airline_iata||airlineIata||"").trim().toUpperCase();
          const airlineIcao=String(row.airline_icao||fr?.airline?.icao||"").trim().toUpperCase();
          const aircraftDesc=String(row.aircraft_icao||row.aircraft_type||row.type||"").trim().toUpperCase();
          // Airport coordinates are reference data, not live telemetry. Resolve them
          // once and keep them in the backend's 24-hour airport cache. The same
          // airport can therefore serve many aircraft without another upstream call.
          let enrichedRoute={fromCode,toCode};
          try{enrichedRoute=await enrichScheduleAirportCoords({fromCode,toCode});}catch(e){}
          const out={
            status:flightNumber?"FOUND":"UNVERIFIED",
            flightNumber,
            airlineCode:airlineIataRow,
            airlineIcao,
            airlineName,
            registration:rowReg,
            hex:rowHex,
            aircraftDesc,
            callsign:String(adsbMatch?.flight||callsign).trim().toUpperCase(),
            route:{
              fromCode,
              toCode,
              from:enrichedRoute.from||fromCode,
              to:enrichedRoute.to||toCode,
              fromLat:enrichedRoute.fromLat??null,
              fromLon:enrichedRoute.fromLon??null,
              toLat:enrichedRoute.toLat??null,
              toLon:enrichedRoute.toLon??null
            },
            flightroute:{
              callsign,
              callsign_icao:callsign,
              callsign_iata:String(row.flight_iata||"").trim().toUpperCase(),
              airline:{name:airlineName,icao:airlineIcao,iata:airlineIataRow},
              origin:{iata_code:fromCode,icao_code:String(row.dep_icao||fr?.origin?.icao_code||"").trim().toUpperCase(),name:String(row.dep_name||fr?.origin?.name||"").trim(),municipality:String(row.dep_city||fr?.origin?.municipality||"").trim(),latitude:enrichedRoute.fromLat??null,longitude:enrichedRoute.fromLon??null},
              destination:{iata_code:toCode,icao_code:String(row.arr_icao||fr?.destination?.icao_code||"").trim().toUpperCase(),name:String(row.arr_name||fr?.destination?.name||"").trim(),municipality:String(row.arr_city||fr?.destination?.municipality||"").trim(),latitude:enrichedRoute.toLat??null,longitude:enrichedRoute.toLon??null}
            },
            live:{
              lat:Number.isFinite(Number(adsbMatch?.lat))?Number(adsbMatch.lat):(Number.isFinite(Number(row.lat))?Number(row.lat):null),
              lng:Number.isFinite(Number(adsbMatch?.lon))?Number(adsbMatch.lon):(Number.isFinite(Number(row.lng))?Number(row.lng):null),
              alt:Number.isFinite(Number(adsbMatch?.alt_baro))?Number(adsbMatch.alt_baro)*0.3048:(Number.isFinite(Number(row.alt))?Number(row.alt):null),
              dir:Number.isFinite(Number(adsbMatch?.track))?Number(adsbMatch.track):(Number.isFinite(Number(row.dir))?Number(row.dir):null),
              speed:Number.isFinite(Number(adsbMatch?.gs))?Number(adsbMatch.gs)*0.514444:(Number.isFinite(Number(row.speed))?Number(row.speed):null),
              v_speed:Number.isFinite(Number(adsbMatch?.baro_rate))?Number(adsbMatch.baro_rate)*0.00508:(Number.isFinite(Number(row.v_speed))?Number(row.v_speed):null),
              status:String(row.status||"").trim()
            },
            _skyProvider:"AirLabs registration→flight",
            _skyLookup:callsign,
            _skyRegistration:reg,
            _skyUpstreamStatus:upstreamStatus
          };
          lookupCache.set(cacheKey,{time:Date.now(),payload:out});
          return json(out,200,{"X-SkyAroundMe-Lookup":"AirLabs"});
        }
        airLabsError=lastError||"AirLabs returned no matching live aircraft";
      }catch(e){airLabsError=String(e?.message||e)}
    }else{
      airLabsError="AIRLABS_API_KEY is not configured";
    }

    // Safe fallback: return route context only. Never promote ADSBdb's
    // callsign-derived IATA value to a passenger flight number.
    const routeKnown=!!(fr?.origin?.iata_code&&fr?.destination?.iata_code);
    const out={
      status:routeKnown?"ROUTE_FOUND":"UNVERIFIED",
      flightNumber:"",
      callsign,
      airlineCode:String(fr?.airline?.iata||"").trim().toUpperCase(),
      airlineIcao:String(fr?.airline?.icao||"").trim().toUpperCase(),
      airlineName:String(fr?.airline?.name||"").trim(),
      registration:reg,
      flightroute:fr,
      route:routeKnown?{fromCode:String(fr.origin.iata_code).toUpperCase(),toCode:String(fr.destination.iata_code).toUpperCase()}:null,
      flightNumberVerified:false,
      _skyProvider:"ADSBdb",
      _skyLookup:callsign,
      _skyAirLabsError:airLabsError
    };
    lookupCache.set(cacheKey,{time:Date.now(),payload:out});
    return json(out,200,{"X-SkyAroundMe-Lookup":"UNVERIFIED"});
  })();
  lookupInFlight.set(cacheKey,promise);
  try{return await promise} finally{lookupInFlight.delete(cacheKey);}
}

const WATCH_CACHE = new Map();
const WATCH_CACHE_MS = 120000;
const AIRLABS_BASE = "https://airlabs.co/api/v9";

function watchClean(v){return String(v||"").toUpperCase().replace(/[^A-Z0-9]/g,"")}
function watchValidDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||""))}
function watchDateOnly(v){
  const d=new Date(v||"");
  return Number.isNaN(d.getTime())?"":d.toISOString().slice(0,10);
}
function watchFlightDateMatches(date,value){
  if(!watchValidDate(date))return true;
  const got=watchDateOnly(value);
  return !got||got===date;
}
function watchAirport(code,name){return {code:String(code||"").toUpperCase(),name:String(name||code||"")}}

async function airLabsFlight(flight){
  const key=String(process.env.AIRLABS_API_KEY||"").trim();
  if(!key)throw new Error("AIRLABS_API_KEY is not configured");
  const url=`${AIRLABS_BASE}/flight?flight_iata=${encodeURIComponent(flight)}&api_key=${encodeURIComponent(key)}`;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const r=await fetch(url,{method:"GET",headers:{Accept:"application/json"},signal:controller.signal});
    const text=await r.text();
    let payload=null;try{payload=JSON.parse(text)}catch{}
    if(!r.ok)throw new Error(`AirLabs HTTP ${r.status}`);
    if(payload?.error)throw new Error(String(payload.error.message||payload.error||"AirLabs error"));
    if(!payload?.response)throw new Error("AirLabs returned no flight response");
    return payload.response;
  }finally{clearTimeout(timer)}
}

async function adsbByHex(hex){
  const value=String(hex||"").trim().toUpperCase();
  if(!/^[0-9A-F]{6}$/.test(value))return [];
  const urls=[
    `https://api.adsb.lol/v2/hex/${encodeURIComponent(value)}`,
    `https://opendata.adsb.fi/api/v2/hex/${encodeURIComponent(value)}`,
    `https://api.airplanes.live/v2/hex/${encodeURIComponent(value)}`
  ];
  for(const url of urls){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    try{
      const r=await fetch(url,{method:"GET",headers:{Accept:"application/json"},signal:controller.signal});
      if(!r.ok)continue;
      const j=await r.json();
      const ac=Array.isArray(j?.ac)?j.ac:[];
      if(ac.length)return ac;
    }catch(e){}
    finally{clearTimeout(timer)}
  }
  return [];
}

function airLabsToAircraft(r,requestedFlight){
  if(!r)return null;
  const hex=String(r.hex||"").trim().toLowerCase();
  const lat=Number(r.lat),lon=Number(r.lng);
  if(!hex||!Number.isFinite(lat)||!Number.isFinite(lon))return null;
  return {
    hex,
    flight:"",
    r:String(r.reg_number||"").trim().toUpperCase(),
    lat,lon,
    alt:Number.isFinite(Number(r.alt))?Number(r.alt):null,
    gs:Number.isFinite(Number(r.speed))?Number(r.speed):null,
    track:Number.isFinite(Number(r.dir))?Number(r.dir):null,
    baro_rate:null,
    t:String(r.aircraft_icao||"").trim().toUpperCase(),
    desc:String(r.aircraft_icao||"").trim().toUpperCase(),
    ownOp:String(r.airline_icao||r.airline_iata||"").trim().toUpperCase(),
    airlineName:String(r.airline_name||"").trim(),
    flightNumber:String(requestedFlight||r.flight_iata||"").trim().toUpperCase(),
    category:"",
    source:"AirLabs live position"
  };
}

function mergeLiveIdentity(base,adsb){
  if(!base)return null;
  const a=adsb||{};
  return {
    ...base,
    flight:String(a.flight||"").trim().toUpperCase(),
    r:String(a.r||base.r||"").trim().toUpperCase(),
    hex:String(a.hex||base.hex||"").trim().toLowerCase(),
    lat:Number.isFinite(Number(a.lat))?Number(a.lat):base.lat,
    lon:Number.isFinite(Number(a.lon))?Number(a.lon):base.lon,
    alt:Number.isFinite(Number(a.alt_baro))?Number(a.alt_baro)*0.3048:base.alt,
    gs:Number.isFinite(Number(a.gs))?Number(a.gs)*0.514444:base.gs,
    track:Number.isFinite(Number(a.track))?Number(a.track):base.track,
    baro_rate:Number.isFinite(Number(a.baro_rate))?Number(a.baro_rate)*0.00508:null,
    t:String(a.t||base.t||"").trim().toUpperCase(),
    desc:String(a.desc||base.desc||"").trim(),
    ownOp:String(a.ownOp||a.operator||base.ownOp||"").trim().toUpperCase(),
    category:String(a.category||base.category||"")
  };
}

const AIRPORT_CACHE = new Map();
const AIRPORT_CACHE_MS = 24*60*60*1000;
async function airLabsAirport(iata){
  const code=String(iata||"").trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(code))return null;
  const hit=AIRPORT_CACHE.get(code);
  if(hit&&Date.now()-hit.time<AIRPORT_CACHE_MS)return hit.value;
  const key=String(process.env.AIRLABS_API_KEY||"").trim();
  if(!key)return null;
  const url=`${AIRLABS_BASE}/airports?iata_code=${encodeURIComponent(code)}&_fields=name,iata_code,lat,lng&api_key=${encodeURIComponent(key)}`;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(url,{method:"GET",headers:{Accept:"application/json"},signal:controller.signal});
    if(!r.ok)return null;
    const text=await r.text();let payload=null;try{payload=JSON.parse(text)}catch{}
    const row=Array.isArray(payload?.response)?payload.response[0]:null;
    const value=row&&Number.isFinite(Number(row.lat))&&Number.isFinite(Number(row.lng))?{name:String(row.name||code),lat:Number(row.lat),lng:Number(row.lng)}:null;
    AIRPORT_CACHE.set(code,{time:Date.now(),value});
    return value;
  }catch(e){return null}finally{clearTimeout(timer)}
}
async function enrichScheduleAirportCoords(out){
  if(!out)return out;
  const [from,to]=await Promise.all([airLabsAirport(out.fromCode),airLabsAirport(out.toCode)]);
  if(from){out.fromLat=from.lat;out.fromLon=from.lng;if(!out.from||out.from===out.fromCode)out.from=from.name;}
  if(to){out.toLat=to.lat;out.toLon=to.lng;if(!out.to||out.to===out.toCode)out.to=to.name;}
  return out;
}
function airLabsSchedule(r,flight,date){
  const dep=r?.dep_time||r?.dep_estimated||r?.dep_actual||"";
  const arr=r?.arr_time||r?.arr_estimated||r?.arr_actual||"";
  const depDate=watchDateOnly(dep);
  const arrDate=watchDateOnly(arr);
  const arrIsoRaw=r?.arr_time_utc||r?.arr_estimated_utc||r?.arr_actual_utc||"";
  const depIsoRaw=r?.dep_time_utc||r?.dep_estimated_utc||r?.dep_actual_utc||"";
  const depIso=depIsoRaw?String(depIsoRaw).replace(' ','T')+'Z':'';
  const arrIso=arrIsoRaw?String(arrIsoRaw).replace(' ','T')+'Z':'';
  const depLocal=String(dep).match(/(?:T|\s)(\d{1,2}:\d{2})/)?.[1]||"";
  const arrLocal=String(arr).match(/(?:T|\s)(\d{1,2}:\d{2})/)?.[1]||"";
  const out={
    status:"NOT_FOUND",flight,date,source:"AirLabs",
    departureTime:depLocal,departureUtc:depIso,departureTimezone:"",
    arrivalTime:arrLocal,arrivalUtc:arrIso,
    registration:String(r?.reg_number||"").trim().toUpperCase(),
    hex:String(r?.hex||"").trim().toUpperCase(),
    fromCode:String(r?.dep_iata||"").trim().toUpperCase(),
    toCode:String(r?.arr_iata||"").trim().toUpperCase(),
    from:String(r?.dep_name||r?.dep_iata||"").trim(),
    to:String(r?.arr_name||r?.arr_iata||"").trim(),
    airlineCode:String(r?.airline_iata||r?.airline_icao||"").trim().toUpperCase(),
    airlineName:String(r?.airline_name||"").trim(),
    aircraftDesc:String(r?.aircraft_icao||"").trim().toUpperCase(),
    statusText:String(r?.status||"").trim(),
    flightIcao:String(r?.flight_icao||"").trim().toUpperCase()
  };
  if((!watchValidDate(date)||!depDate||depDate===date)&&out.departureTime){out.status="FOUND";}
  else if(!out.departureTime&&r?.status){out.status="FOUND";}
  return out;
}

async function handleWatchedSchedule(flight,date){
  flight=watchClean(flight);date=String(date||"");
  if(!flight||!watchValidDate(date))return json({status:"NOT_FOUND",flight,date},200);
  const key=`schedule|${flight}|${date}`;
  const hit=WATCH_CACHE.get(key);
  if(hit&&Date.now()-hit.time<WATCH_CACHE_MS)return json(hit.value,200,{"X-SkyAroundMe-Lookup-Cache":"HIT"});
  let out={status:"NOT_FOUND",flight,date,source:"AirLabs",departureTime:"",departureUtc:"",arrivalUtc:"",registration:"",hex:"",fromCode:"",toCode:""};
  try{
    const r=await airLabsFlight(flight);
    out=airLabsSchedule(r,flight,date);
    out=await enrichScheduleAirportCoords(out);
    if(out.status==="FOUND" && out.registration){out._liveCandidate=true;}
  }catch(e){
    out._error=String(e?.message||e);
  }
  WATCH_CACHE.set(key,{time:Date.now(),value:out});
  return json(out,200,{"X-SkyAroundMe-Lookup":out.status});
}

async function handleWatchedFlight(flight,date){
  flight=watchClean(flight);date=String(date||"");
  if(!flight||!watchValidDate(date))return json({status:"NOT_FOUND",flight,date,ac:[]},200);
  const key=`flight|${flight}|${date}`;
  const hit=WATCH_CACHE.get(key);
  if(hit&&Date.now()-hit.time<WATCH_CACHE_MS)return json(hit.value,200,{"X-SkyAroundMe-Lookup-Cache":"HIT"});

  let r=null,schedule=null;
  try{
    r=await airLabsFlight(flight);
    schedule=await enrichScheduleAirportCoords(airLabsSchedule(r,flight,date));
  }catch(e){
    const out={status:"ERROR",flight,date,ac:[],schedule:null,source:"AirLabs",resolver:"AIRLABS_ERROR",error:String(e?.message||e)};
    WATCH_CACHE.set(key,{time:Date.now(),value:out});
    return json(out,200,{"X-SkyAroundMe-Lookup":"ERROR"});
  }

  const base=airLabsToAircraft(r,flight);
  let liveAdsb=[];
  if(r?.hex)liveAdsb=await adsbByHex(r.hex);
  const exact=liveAdsb.find(a=>String(a?.hex||"").trim().toUpperCase()===String(r.hex||"").trim().toUpperCase())||liveAdsb[0]||null;
  const aircraft=base?mergeLiveIdentity(base,exact):null;
  const isLive=String(r?.status||"").toLowerCase()==="en-route"||String(r?.status||"").toLowerCase()==="active";

  const out={
    status:aircraft&&isLive?"FOUND":"NOT_FOUND",
    flight,date,
    ac:aircraft?[aircraft]:[],
    schedule,
    source:"AirLabs + ADSB.lol",
    resolver:exact?"AIRLABS_FLIGHT_NUMBER→HEX→ADSB.LOL":"AIRLABS_FLIGHT_NUMBER",
    resolvedFlightNumber:String(r?.flight_iata||flight).trim().toUpperCase(),
    airLabsFlightIcao:String(r?.flight_icao||"").trim().toUpperCase(),
    airLabsRegistration:String(r?.reg_number||"").trim().toUpperCase(),
    airLabsHex:String(r?.hex||"").trim().toUpperCase(),
    adsbVerified:!!exact
  };
  WATCH_CACHE.set(key,{time:Date.now(),value:out});
  return json(out,200,{"X-SkyAroundMe-Lookup":out.status});
}


// Netlify Functions (Node 18/20) entry point.
// Keep the internal code Request/Response based, but expose the handler
// property Netlify expects for a .js function.
exports.handler = async (event) => {
  const baseHeaders={
    "Content-Type":"application/json; charset=utf-8",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type, Accept",
    "Cache-Control":"no-store"
  };
  try{
    const method = String(event?.httpMethod || "GET").toUpperCase();
    const headers = new Headers(event?.headers || {});
    const qs = event?.rawQuery || "";
    const url = `https://sky-around-me.netlify.app/.netlify/functions/adsb${qs ? `?${qs}` : ""}`;
    const request = new Request(url, { method, headers });
    const response = await skyAroundMeRequest(request);
    const body = await response.text();
    const outHeaders = {...baseHeaders};
    response.headers.forEach((value, key) => { outHeaders[key] = value; });
    return {statusCode: response.status,headers: outHeaders,body,isBase64Encoded:false};
  }catch(e){
    return {statusCode:500,headers:baseHeaders,body:JSON.stringify({ok:false,error:"Function error",message:String(e?.message||e)}) ,isBase64Encoded:false};
  }
};
