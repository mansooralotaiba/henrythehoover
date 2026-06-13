//+------------------------------------------------------------------+
//|                                            HenryGoldHybridEA.mq5  |
//|   Henry The Hoover — HYBRID gold EA for MetaTrader 5.            |
//|                                                                   |
//|   Generates gold setups LOCALLY using Henry's full 5-trigger      |
//|   ICT set (MSS+disp, sweep+disp, order block, S&D zone,           |
//|   FVG-in-OTE), filtered by HIGHER-TIMEFRAME trend, with           |
//|   breakeven management and an optional AI confirm from Henry.     |
//|                                                                   |
//|   Self-contained → runs in the MT5 Strategy Tester (the AI        |
//|   confirm is auto-skipped there since WebRequest is disabled).    |
//|                                                                   |
//|   *** DEMO FIRST. In the Strategy Tester set InpEnableTrading=true |
//|   (it's simulated). On a LIVE chart keep it false to observe.     |
//+------------------------------------------------------------------+
#property copyright "Henry The Hoover"
#property version   "2.00"
#property strict
#include <Trade/Trade.mqh>

//--- Trading ---------------------------------------------------------
input bool    InpEnableTrading   = false;   // master switch (tester: set true; live: false to observe first)
input double  InpRiskPct         = 1.0;     // % of balance risked per trade
input double  InpFixedRiskUsd    = 0;       // if > 0, fixed $ risk instead of %
input double  InpMaxLots         = 1.0;     // safety cap
input long    InpMagic           = 760521;
input int     InpSlippage        = 30;

//--- Strategy --------------------------------------------------------
input double  InpRR              = 2.0;     // take-profit = RR × stop distance
input double  InpStopATRmult     = 1.0;     // stop = further of candle extreme and entry±(mult×ATR); 0 = candle only
input int     InpCooldownBars    = 1;       // min bars between entries

//--- Higher-timeframe confirmation (replaces shorts-only) ------------
input bool    InpUseHTFConfirm   = true;    // only trade with (or neutral to) the HTF trend
input ENUM_TIMEFRAMES InpHTF     = PERIOD_H4;
input int     InpHTFFastEMA      = 20;
input int     InpHTFSlowEMA      = 50;
input bool    InpHTFBlockRange   = false;   // true = also skip when HTF is range/chop

//--- Breakeven management --------------------------------------------
input bool    InpUseBE           = true;
input double  InpBETriggerR      = 1.0;     // move SL to BE once price is +this×risk in profit
input int     InpBEBufferPts     = 20;      // BE offset in points (fees/spread buffer)

//--- Henry AI confirm (graceful fallback) ----------------------------
input bool    InpUseHenryConfirm = true;
input string  InpHenryUrl        = "https://henrythehoover.com";
input string  InpToken           = "";
input bool    InpRequireConfirm  = false;   // Henry unreachable → false: trade mechanically, true: skip

CTrade   trade;
datetime g_lastBar = 0, g_lastEntryBar = 0;
int      g_atr = INVALID_HANDLE, g_emaFast = INVALID_HANDLE, g_emaSlow = INVALID_HANDLE;
string   g_trig = "";

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(_Symbol);
   g_atr     = iATR(_Symbol, PERIOD_CURRENT, 14);
   g_emaFast = iMA(_Symbol, InpHTF, InpHTFFastEMA, 0, MODE_EMA, PRICE_CLOSE);
   g_emaSlow = iMA(_Symbol, InpHTF, InpHTFSlowEMA, 0, MODE_EMA, PRICE_CLOSE);
   if(g_atr==INVALID_HANDLE || g_emaFast==INVALID_HANDLE || g_emaSlow==INVALID_HANDLE){ Print("indicator handle failed"); return INIT_FAILED; }
   PrintFormat("HenryGoldHybridEA v2 on %s %s | trade=%s | HTF-confirm=%s(%s) | BE=%s | confirm=%s",
               _Symbol, EnumToString((ENUM_TIMEFRAMES)_Period), (InpEnableTrading?"ON":"OFF"),
               (InpUseHTFConfirm?"on":"off"), EnumToString(InpHTF), (InpUseBE?"on":"off"),
               (InpUseHenryConfirm?"Henry-AI":"mechanical"));
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason){ }

//+------------------------------------------------------------------+
void OnTick()
{
   if(InpUseBE) ManageBreakeven();
   datetime bt = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(bt == g_lastBar) return;
   g_lastBar = bt;
   EvaluateSetup();
}

//+------------------------------------------------------------------+
void EvaluateSetup()
{
   if(HasOpenPosition()) return;
   if(g_lastEntryBar != 0 && iBarShift(_Symbol, PERIOD_CURRENT, g_lastEntryBar) < InpCooldownBars) return;

   MqlRates c[]; ArraySetAsSeries(c, false);          // chronological: c[n-1] = last CLOSED bar
   int n = CopyRates(_Symbol, PERIOD_CURRENT, 1, 40, c);
   if(n < 35) return;

   g_trig = "";
   int dir = DetectSignal(c, n);                       // 1 long, -1 short, 0 none (sets g_trig)
   if(dir == 0) return;

   // Higher-timeframe confirmation — don't fight a clear HTF trend
   if(InpUseHTFConfirm){
      int t = HTFTrend();                              // 1 up, -1 down, 0 range
      if(dir == 1 && t == -1) return;
      if(dir == -1 && t == 1) return;
      if(InpHTFBlockRange && t == 0) return;
   }

   MqlRates last = c[n-1];
   double entry = (dir==1) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double atr = ATRval();
   double sl;
   if(dir==1){ sl = last.low;  if(InpStopATRmult>0 && atr>0) sl = MathMin(sl, entry - InpStopATRmult*atr); }
   else      { sl = last.high; if(InpStopATRmult>0 && atr>0) sl = MathMax(sl, entry + InpStopATRmult*atr); }
   double slDist = MathAbs(entry - sl);
   if(slDist <= 0 || slDist/entry < 0.0005) return;
   double tp = (dir==1) ? entry + InpRR*slDist : entry - InpRR*slDist;
   string sigId = g_trig + "-" + IntegerToString((long)last.time);

   if(InpUseHenryConfirm){
      int v = AskHenryConfirm(sigId, dir, entry, sl, tp);   // 1 confirm, -1 veto, 0 unreachable
      if(v == -1){ PrintFormat("VETO %s %s", g_trig, (dir==1?"long":"short")); return; }
      if(v == 0 && InpRequireConfirm){ Print("Henry unreachable + require → skip"); return; }
   }
   PlaceTrade(sigId, dir, entry, sl, tp, slDist);
}

//+------------------------------------------------------------------+
//| Full 5-trigger ICT chain (priority: MSS > sweep > OB > S&D > FVG) |
//| Returns 1 long / -1 short / 0 none; sets g_trig.                 |
//+------------------------------------------------------------------+
int DetectSignal(const MqlRates &c[], int n)
{
   int d;
   d = detMSS(c,n);    if(d!=0){ g_trig="mss_disp";   return d; }
   d = detSweep(c,n);  if(d!=0){ g_trig="sweep_disp"; return d; }
   d = detOB(c,n);     if(d!=0){ g_trig="ob_mitigation"; return d; }
   d = detSDZone(c,n); if(d!=0){ g_trig="sd_zone";    return d; }
   d = detFVGOTE(c,n); if(d!=0){ g_trig="fvg_ote";    return d; }
   return 0;
}

// 1) MSS + displacement
int detMSS(const MqlRates &c[], int n)
{
   MqlRates last=c[n-1];
   double maxH=-1e18,minL=1e18,sv=0;
   for(int i=n-11;i<=n-2;i++){ maxH=MathMax(maxH,c[i].high); minL=MathMin(minL,c[i].low); sv+=(double)c[i].tick_volume; }
   double avgVol=sv/10.0, rng=last.high-last.low; if(rng<=0||avgVol<=0) return 0;
   double bodyPct=MathAbs(last.close-last.open)/rng;
   if((double)last.tick_volume<=avgVol*1.5 || bodyPct<0.6) return 0;
   if(last.close>maxH && last.close>last.open) return 1;
   if(last.close<minL && last.close<last.open) return -1;
   return 0;
}
// 2) sweep + displacement
int detSweep(const MqlRates &c[], int n)
{
   MqlRates last=c[n-1];
   double maxH=-1e18,minL=1e18,sv=0;
   for(int i=n-11;i<=n-2;i++){ maxH=MathMax(maxH,c[i].high); minL=MathMin(minL,c[i].low); sv+=(double)c[i].tick_volume; }
   double avgVol=sv/10.0, rng=last.high-last.low; if(rng<=0||avgVol<=0) return 0;
   if((double)last.tick_volume<=avgVol*1.2) return 0;
   if(last.low<minL && last.close>minL && (last.close-last.low)/rng>=0.6) return 1;
   if(last.high>maxH && last.close<maxH && (last.high-last.close)/rng>=0.6) return -1;
   return 0;
}
// 3) order block mitigation
int detOB(const MqlRates &c[], int n)
{
   MqlRates last=c[n-1];
   for(int i=n-25;i<=n-5;i++){
      if(i<0) continue;
      int nend=MathMin(i+5,n); if(nend-(i+1)<3) continue;
      double obRange=c[i].high-c[i].low; if(obRange<=0) continue;
      bool isRed=c[i].close<c[i].open, isGreen=c[i].close>c[i].open;
      if(isRed){
         double mh=-1e18; for(int k=i+1;k<nend;k++) mh=MathMax(mh,c[k].high);
         if(mh-c[i].low > obRange*1.5){
            double obTop=c[i].high, obBot=c[i].low; bool mit=false;
            for(int k=i+1;k<=n-2;k++) if(c[k].low<=obTop && c[k].low>obBot && c[k].high>obTop){ mit=true; break; }
            if(mit) continue;
            if(last.low<=obTop && last.low>=obBot) return 1;
         }
      }
      if(isGreen){
         double ml=1e18; for(int k=i+1;k<nend;k++) ml=MathMin(ml,c[k].low);
         if(c[i].high-ml > obRange*1.5){
            double obTop=c[i].high, obBot=c[i].low; bool mit=false;
            for(int k=i+1;k<=n-2;k++) if(c[k].high>=obBot && c[k].high<obTop && c[k].low<obBot){ mit=true; break; }
            if(mit) continue;
            if(last.high>=obBot && last.high<=obTop) return -1;
         }
      }
   }
   return 0;
}
// 4) supply/demand zone retest
int detSDZone(const MqlRates &c[], int n)
{
   MqlRates last=c[n-1];
   for(int i=n-25;i<=n-8;i++){
      if(i<5) continue;
      for(int bs=3;bs<=5;bs++){
         int baseEnd=i+bs; if(baseEnd>=n-3) break;
         double bH=-1e18,bL=1e18; for(int k=i;k<baseEnd;k++){ bH=MathMax(bH,c[k].high); bL=MathMin(bL,c[k].low); }
         double baseRange=bH-bL; if(baseRange<=0) continue;
         double surr=0; for(int k=MathMax(0,i-5);k<i;k++) surr+=(c[k].high-c[k].low); surr/=5.0;
         if(surr>0 && baseRange>surr*1.5) continue;
         int aEnd=MathMin(baseEnd+4,n-1); if(aEnd-baseEnd<3) continue;
         double aH=-1e18,aL=1e18; for(int k=baseEnd;k<aEnd;k++){ aH=MathMax(aH,c[k].high); aL=MathMin(aL,c[k].low); }
         double moveUp=aH-bH, moveDown=bL-aL;
         if(moveUp>baseRange*1.5 && moveUp>moveDown){
            bool ret=false; for(int k=baseEnd+4;k<=n-2;k++) if(c[k].low<=bH && c[k].low>=bL){ ret=true; break; }
            if(ret) continue;
            if(last.low<=bH && last.low>=bL*0.998) return 1;
         }
         if(moveDown>baseRange*1.5 && moveDown>moveUp){
            bool ret=false; for(int k=baseEnd+4;k<=n-2;k++) if(c[k].high>=bL && c[k].high<=bH){ ret=true; break; }
            if(ret) continue;
            if(last.high>=bL && last.high<=bH*1.002) return -1;
         }
      }
   }
   return 0;
}
// 5) FVG in OTE zone
int detFVGOTE(const MqlRates &c[], int n)
{
   MqlRates last=c[n-1]; double cp=last.close;
   double sH=-1e18,sL=1e18; for(int k=n-30;k<n;k++){ sH=MathMax(sH,c[k].high); sL=MathMin(sL,c[k].low); }
   double range=sH-sL; if(range<=0) return 0;
   double oteBotL=sH-range*0.79, oteTopL=sH-range*0.62, oteBotS=sL+range*0.62, oteTopS=sL+range*0.79;
   for(int i=n-22;i<n-1;i++){
      if(i<1) continue;
      MqlRates c0=c[i-1], c2=c[i+1];
      if(c2.low>c0.high){
         double ft=c2.low, fb=c0.high, fm=(ft+fb)/2;
         if(fm>=oteBotL && fm<=oteTopL && cp>=fb && cp<=ft){
            bool filled=false; for(int k=i+2;k<=n-2;k++) if(c[k].low<fb){ filled=true; break; }
            if(!filled) return 1;
         }
      }
      if(c2.high<c0.low){
         double ft=c0.low, fb=c2.high, fm=(ft+fb)/2;
         if(fm>=oteBotS && fm<=oteTopS && cp>=fb && cp<=ft){
            bool filled=false; for(int k=i+2;k<=n-2;k++) if(c[k].high>ft){ filled=true; break; }
            if(!filled) return -1;
         }
      }
   }
   return 0;
}

//+------------------------------------------------------------------+
//| Higher-timeframe trend: 1 up / -1 down / 0 range                 |
//+------------------------------------------------------------------+
int HTFTrend()
{
   double f[],s[]; ArraySetAsSeries(f,true); ArraySetAsSeries(s,true);
   if(CopyBuffer(g_emaFast,0,1,1,f)<1 || CopyBuffer(g_emaSlow,0,1,1,s)<1) return 0;
   double px = iClose(_Symbol, InpHTF, 1);
   if(px>f[0] && f[0]>s[0]) return 1;
   if(px<f[0] && f[0]<s[0]) return -1;
   return 0;
}
double ATRval(){ double a[]; ArraySetAsSeries(a,true); if(CopyBuffer(g_atr,0,1,1,a)<1) return 0; return a[0]; }

//+------------------------------------------------------------------+
//| Breakeven — move SL to entry(+buffer) once +InpBETriggerR×risk    |
//+------------------------------------------------------------------+
void ManageBreakeven()
{
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong tk=PositionGetTicket(i); if(tk==0) continue;
      if(PositionGetInteger(POSITION_MAGIC)!=InpMagic || PositionGetString(POSITION_SYMBOL)!=_Symbol) continue;
      long type=PositionGetInteger(POSITION_TYPE);
      double entry=PositionGetDouble(POSITION_PRICE_OPEN), curSL=PositionGetDouble(POSITION_SL), tp=PositionGetDouble(POSITION_TP);
      double buf=InpBEBufferPts*_Point;
      if(type==POSITION_TYPE_BUY && curSL<entry){
         double risk=entry-curSL; if(risk<=0) continue;
         if(SymbolInfoDouble(_Symbol,SYMBOL_BID) >= entry + InpBETriggerR*risk){
            double nsl=NormalizeDouble(entry+buf,(int)SymbolInfoInteger(_Symbol,SYMBOL_DIGITS));
            if(nsl>curSL) trade.PositionModify(tk,nsl,tp);
         }
      } else if(type==POSITION_TYPE_SELL && curSL>entry){
         double risk=curSL-entry; if(risk<=0) continue;
         if(SymbolInfoDouble(_Symbol,SYMBOL_ASK) <= entry - InpBETriggerR*risk){
            double nsl=NormalizeDouble(entry-buf,(int)SymbolInfoInteger(_Symbol,SYMBOL_DIGITS));
            if(nsl<curSL) trade.PositionModify(tk,nsl,tp);
         }
      }
   }
}

//+------------------------------------------------------------------+
void PlaceTrade(string sigId,int dir,double entry,double sl,double tp,double slDist)
{
   double lots=ComputeLots(slDist); if(lots<=0){ Print("skip ",sigId," lots=0"); return; }
   int dg=(int)SymbolInfoInteger(_Symbol,SYMBOL_DIGITS); sl=NormalizeDouble(sl,dg); tp=NormalizeDouble(tp,dg);
   string side=(dir==1)?"buy":"sell";
   if(!InpEnableTrading){
      PrintFormat("[observe] would %s %.2f %s @ %.2f SL %.2f TP %.2f (%s)",side,lots,_Symbol,entry,sl,tp,sigId);
      g_lastEntryBar=iTime(_Symbol,PERIOD_CURRENT,0); return;
   }
   bool ok=(dir==1)?trade.Buy(lots,_Symbol,0.0,sl,tp,sigId):trade.Sell(lots,_Symbol,0.0,sl,tp,sigId);
   if(ok){ g_lastEntryBar=iTime(_Symbol,PERIOD_CURRENT,0);
      ReportEvent(sigId,"filled",trade.ResultPrice(),lots,(string)trade.ResultOrder(),0.0,side);
      PrintFormat("OPENED %s %.2f %s @ %.2f (%s)",side,lots,_Symbol,trade.ResultPrice(),sigId);
   } else PrintFormat("ORDER FAIL %s ret=%d %s",sigId,trade.ResultRetcode(),trade.ResultRetcodeDescription());
}

double ComputeLots(double slDist)
{
   double riskMoney=(InpFixedRiskUsd>0)?InpFixedRiskUsd:AccountInfoDouble(ACCOUNT_BALANCE)*InpRiskPct/100.0;
   double tv=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE), ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   if(tv<=0||ts<=0) return 0;
   double mpl=(slDist/ts)*tv; if(mpl<=0) return 0;
   double lots=riskMoney/mpl;
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP), mn=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN), mx=MathMin(SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),InpMaxLots);
   if(step>0) lots=MathFloor(lots/step)*step;
   if(lots<mn) lots=mn; if(lots>mx) lots=mx;
   return NormalizeDouble(lots,2);
}

int AskHenryConfirm(string sigId,int dir,double entry,double sl,double tp)
{
   string json=StringFormat("{\"signalId\":\"%s\",\"symbol\":\"%s\",\"direction\":\"%s\",\"entry\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"tf\":\"%s\"}",
                            sigId,_Symbol,(dir==1?"LONG":"SHORT"),entry,sl,tp,EnumToString((ENUM_TIMEFRAMES)_Period));
   char post[],result[]; string rh=""; StringToCharArray(json,post,0,StringLen(json));
   string headers="Authorization: Bearer "+InpToken+"\r\nContent-Type: application/json\r\n";
   ResetLastError();
   int code=WebRequest("POST",InpHenryUrl+"/api/mt5/confirm",headers,5000,post,result,rh);
   if(code!=200) return 0;
   string body=CharArrayToString(result); StringToLower(body);
   if(StringFind(body,"veto")>=0 && StringFind(body,"confirm")<0) return -1;
   if(StringFind(body,"confirm")>=0) return 1;
   return 0;
}

void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
{
   if(trans.type!=TRADE_TRANSACTION_DEAL_ADD) return;
   ulong deal=trans.deal; if(deal==0||!HistoryDealSelect(deal)) return;
   if(HistoryDealGetInteger(deal,DEAL_MAGIC)!=InpMagic) return;
   if(HistoryDealGetInteger(deal,DEAL_ENTRY)!=DEAL_ENTRY_OUT) return;
   string id=HistoryDealGetString(deal,DEAL_COMMENT);
   double price=HistoryDealGetDouble(deal,DEAL_PRICE);
   double pnl=HistoryDealGetDouble(deal,DEAL_PROFIT)+HistoryDealGetDouble(deal,DEAL_SWAP)+HistoryDealGetDouble(deal,DEAL_COMMISSION);
   double lots=HistoryDealGetDouble(deal,DEAL_VOLUME); long rs=HistoryDealGetInteger(deal,DEAL_REASON);
   string evt=(rs==DEAL_REASON_TP)?"tp":(rs==DEAL_REASON_SL?"sl":"closed");
   if(StringLen(id)>0) ReportEvent(id,evt,price,lots,(string)deal,pnl,"");
}

void ReportEvent(string signalId,string evt,double price,double lots,string ticket,double pnl,string side)
{
   if(InpHenryUrl==""||InpToken=="") return;
   string acct=(string)AccountInfoInteger(ACCOUNT_LOGIN);
   string json="{\"signalId\":\""+signalId+"\",\"event\":\""+evt+"\",\"symbol\":\""+_Symbol+"\",";
   if(side!="") json+="\"side\":\""+side+"\",";
   json+="\"price\":"+DoubleToString(price,2)+",\"lots\":"+DoubleToString(lots,2)+",\"ticket\":\""+ticket+"\",\"pnl\":"+DoubleToString(pnl,2)+",\"accountId\":\""+acct+"\"}";
   char post[],result[]; string rh=""; StringToCharArray(json,post,0,StringLen(json));
   string headers="Authorization: Bearer "+InpToken+"\r\nContent-Type: application/json\r\n";
   ResetLastError(); WebRequest("POST",InpHenryUrl+"/api/mt5/report",headers,5000,post,result,rh);
}

bool HasOpenPosition()
{
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong tk=PositionGetTicket(i); if(tk==0) continue;
      if(PositionGetInteger(POSITION_MAGIC)==InpMagic && PositionGetString(POSITION_SYMBOL)==_Symbol) return true;
   }
   return false;
}
//+------------------------------------------------------------------+
