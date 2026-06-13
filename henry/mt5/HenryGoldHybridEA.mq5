//+------------------------------------------------------------------+
//|                                            HenryGoldHybridEA.mq5  |
//|   Henry The Hoover — HYBRID gold EA for MetaTrader 5.            |
//|                                                                   |
//|   • Generates gold setups LOCALLY (ICT mechanical triggers:       |
//|     MSS+displacement, sweep+displacement) — so it's fully         |
//|     self-contained and runs in the MT5 Strategy Tester.           |
//|   • When a setup fires, optionally asks Henry's AI to confirm     |
//|     or veto it (POST /api/mt5/confirm). If Henry is unreachable   |
//|     (e.g. inside the Strategy Tester, where WebRequest is off),   |
//|     it falls back to trading mechanically (or skips — your call). |
//|   • Places with a hard SL + TP, then reports fills/TP/SL to       |
//|     Henry for the dashboard.                                      |
//|                                                                   |
//|   Backtest in the Strategy Tester = the MECHANICAL layer (no AI). |
//|   Live = mechanical detection + AI confirm. Defaults reflect the  |
//|   gold backtest: shorts-only, RR 2, run on a 15m chart.           |
//|                                                                   |
//|   *** DEMO FIRST. InpEnableTrading is OFF by default (logs        |
//|   '[observe] would …' so you can validate before any real order). |
//+------------------------------------------------------------------+
#property copyright "Henry The Hoover"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- Trading ---------------------------------------------------------
input bool    InpEnableTrading   = false;   // MASTER SWITCH — start OFF (observe/log only)
input double  InpRiskPct         = 1.0;     // % of balance risked per trade
input double  InpFixedRiskUsd    = 0;       // if > 0, risk this fixed $ instead of the %
input double  InpMaxLots         = 1.0;     // hard safety cap
input long    InpMagic           = 760521;  // magic number tagging this EA's trades
input int     InpSlippage        = 30;      // max deviation (points)

//--- Strategy (defaults from the 90-day gold backtest) ---------------
input bool    InpShortsOnly      = true;    // gold's edge is short-only; longs lose
input double  InpRR              = 2.0;     // take-profit = RR × stop distance
input int     InpCooldownBars    = 1;       // min bars between entries

//--- Henry AI confirm (graceful fallback if unreachable) -------------
input bool    InpUseHenryConfirm = true;    // ask Henry's AI to confirm each setup
input string  InpHenryUrl        = "https://henrythehoover.com";
input string  InpToken           = "";      // HENRY_MT5_TOKEN
input bool    InpRequireConfirm  = false;   // Henry unreachable → false: trade mechanically, true: skip

CTrade   trade;
datetime g_lastBar = 0;
datetime g_lastEntryBar = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(_Symbol);
   PrintFormat("HenryGoldHybridEA on %s %s | trading=%s | %s | confirm=%s",
               _Symbol, EnumToString((ENUM_TIMEFRAMES)_Period),
               (InpEnableTrading ? "ON" : "OFF (observe)"),
               (InpShortsOnly ? "SHORTS-ONLY" : "both dirs"),
               (InpUseHenryConfirm ? "Henry-AI" : "mechanical-only"));
   if(InpUseHenryConfirm && InpToken == "") Print("WARN: InpToken empty — confirm calls will fail → mechanical fallback");
   return(INIT_SUCCEEDED);
}
void OnDeinit(const int reason) {}

//+------------------------------------------------------------------+
//| Evaluate once per new bar (on the last CLOSED bar)               |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime bt = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(bt == g_lastBar) return;
   g_lastBar = bt;
   EvaluateSetup();
}

void EvaluateSetup()
{
   if(HasOpenPosition()) return;
   if(g_lastEntryBar != 0 && (iBarShift(_Symbol, PERIOD_CURRENT, g_lastEntryBar) < InpCooldownBars)) return;

   MqlRates r[];
   ArraySetAsSeries(r, true);
   if(CopyRates(_Symbol, PERIOD_CURRENT, 1, 12, r) < 12) return;   // r[0] = last closed bar, r[1..10] = prior 10

   double maxH = r[1].high, minL = r[1].low; double sumVol = 0;
   for(int i = 1; i <= 10; i++){ maxH = MathMax(maxH, r[i].high); minL = MathMin(minL, r[i].low); sumVol += (double)r[i].tick_volume; }
   double avgVol = sumVol / 10.0;
   double rng = r[0].high - r[0].low;
   if(rng <= 0 || avgVol <= 0) return;
   double bodyPct = MathAbs(r[0].close - r[0].open) / rng;
   double vol = (double)r[0].tick_volume;

   int dir = 0; string trig = "";
   // 1) MSS + displacement
   if(vol > avgVol * 1.5 && bodyPct >= 0.6){
      if(r[0].close > maxH && r[0].close > r[0].open){ dir = 1;  trig = "mss_disp"; }
      else if(r[0].close < minL && r[0].close < r[0].open){ dir = -1; trig = "mss_disp"; }
   }
   // 2) sweep + displacement
   if(dir == 0 && vol > avgVol * 1.2){
      if(r[0].low < minL && r[0].close > minL && (r[0].close - r[0].low)/rng >= 0.6){ dir = 1;  trig = "sweep_disp"; }
      else if(r[0].high > maxH && r[0].close < maxH && (r[0].high - r[0].close)/rng >= 0.6){ dir = -1; trig = "sweep_disp"; }
   }
   if(dir == 0) return;
   if(InpShortsOnly && dir == 1) return;           // gold longs lose — gated by default

   double entry = (dir == 1) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double sl    = (dir == 1) ? r[0].low : r[0].high;     // stop at the trigger bar's far extreme
   double slDist = MathAbs(entry - sl);
   if(slDist <= 0 || slDist/entry < 0.0005) return;       // degenerate / too-tight stop
   double tp = (dir == 1) ? entry + InpRR*slDist : entry - InpRR*slDist;

   string sigId = trig + "-" + IntegerToString((long)r[0].time);

   // --- AI confirm (graceful fallback) ---
   if(InpUseHenryConfirm){
      int verdict = AskHenryConfirm(sigId, dir, entry, sl, tp);   // 1=confirm, -1=veto, 0=unreachable
      if(verdict == -1){ PrintFormat("VETO by Henry — skip %s %s", trig, (dir==1?"long":"short")); return; }
      if(verdict == 0 && InpRequireConfirm){ Print("Henry unreachable + require-confirm → skip"); return; }
   }

   PlaceTrade(sigId, dir, trig, entry, sl, tp, slDist);
}

//+------------------------------------------------------------------+
void PlaceTrade(string sigId, int dir, string trig, double entry, double sl, double tp, double slDist)
{
   double lots = ComputeLots(slDist);
   if(lots <= 0){ Print("skip ", sigId, " — lot size 0"); return; }
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   sl = NormalizeDouble(sl, digits); tp = NormalizeDouble(tp, digits);
   string side = (dir == 1) ? "buy" : "sell";

   if(!InpEnableTrading){
      PrintFormat("[observe] would %s %.2f %s @ %.2f SL %.2f TP %.2f (%s)", side, lots, _Symbol, entry, sl, tp, sigId);
      g_lastEntryBar = iTime(_Symbol, PERIOD_CURRENT, 0);
      return;
   }
   bool ok = (dir == 1) ? trade.Buy(lots, _Symbol, 0.0, sl, tp, sigId)
                        : trade.Sell(lots, _Symbol, 0.0, sl, tp, sigId);
   if(ok){
      g_lastEntryBar = iTime(_Symbol, PERIOD_CURRENT, 0);
      ReportEvent(sigId, "filled", trade.ResultPrice(), lots, (string)trade.ResultOrder(), 0.0, side);
      PrintFormat("OPENED %s %.2f %s @ %.2f (%s)", side, lots, _Symbol, trade.ResultPrice(), sigId);
   }
   else PrintFormat("ORDER FAILED %s: ret=%d %s", sigId, trade.ResultRetcode(), trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
double ComputeLots(double slDist)
{
   double riskMoney = (InpFixedRiskUsd > 0) ? InpFixedRiskUsd
                                            : AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPct / 100.0;
   double tickVal = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSz  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickVal <= 0 || tickSz <= 0) return 0;
   double moneyPerLot = (slDist / tickSz) * tickVal;
   if(moneyPerLot <= 0) return 0;
   double lots = riskMoney / moneyPerLot;
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = MathMin(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX), InpMaxLots);
   if(step > 0) lots = MathFloor(lots / step) * step;
   if(lots < minL) lots = minL;
   if(lots > maxL) lots = maxL;
   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//| Ask Henry to confirm. Returns 1=confirm, -1=veto, 0=unreachable. |
//| Fails fast in the Strategy Tester (WebRequest disabled) → 0.     |
//+------------------------------------------------------------------+
int AskHenryConfirm(string sigId, int dir, double entry, double sl, double tp)
{
   string json = StringFormat("{\"signalId\":\"%s\",\"symbol\":\"%s\",\"direction\":\"%s\",\"entry\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"tf\":\"%s\"}",
                              sigId, _Symbol, (dir==1?"LONG":"SHORT"), entry, sl, tp, EnumToString((ENUM_TIMEFRAMES)_Period));
   char post[], result[]; string rh = "";
   StringToCharArray(json, post, 0, StringLen(json));
   string headers = "Authorization: Bearer " + InpToken + "\r\nContent-Type: application/json\r\n";
   ResetLastError();
   int code = WebRequest("POST", InpHenryUrl + "/api/mt5/confirm", headers, 5000, post, result, rh);
   if(code == -1 || code != 200) return 0;            // unreachable / tester / error → fallback
   string body = CharArrayToString(result);
   StringToLower(body);
   if(StringFind(body, "confirm") >= 0) return 1;
   if(StringFind(body, "veto") >= 0)    return -1;
   return 0;
}

//+------------------------------------------------------------------+
//| Report fills / TP / SL / close to Henry (best-effort).           |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   ulong deal = trans.deal;
   if(deal == 0 || !HistoryDealSelect(deal)) return;
   if(HistoryDealGetInteger(deal, DEAL_MAGIC) != InpMagic) return;
   if(HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) return;
   string id = HistoryDealGetString(deal, DEAL_COMMENT);
   double price = HistoryDealGetDouble(deal, DEAL_PRICE);
   double pnl = HistoryDealGetDouble(deal, DEAL_PROFIT) + HistoryDealGetDouble(deal, DEAL_SWAP) + HistoryDealGetDouble(deal, DEAL_COMMISSION);
   double lots = HistoryDealGetDouble(deal, DEAL_VOLUME);
   long reason = HistoryDealGetInteger(deal, DEAL_REASON);
   string evt = (reason == DEAL_REASON_TP) ? "tp" : (reason == DEAL_REASON_SL ? "sl" : "closed");
   if(StringLen(id) > 0) ReportEvent(id, evt, price, lots, (string)deal, pnl, "");
}

void ReportEvent(string signalId, string event, double price, double lots, string ticket, double pnl, string side)
{
   if(InpHenryUrl == "" || InpToken == "") return;
   string acct = (string)AccountInfoInteger(ACCOUNT_LOGIN);
   string json = "{\"signalId\":\"" + signalId + "\",\"event\":\"" + event + "\",\"symbol\":\"" + _Symbol + "\",";
   if(side != "") json += "\"side\":\"" + side + "\",";
   json += "\"price\":" + DoubleToString(price,2) + ",\"lots\":" + DoubleToString(lots,2) + ",\"ticket\":\"" + ticket + "\",\"pnl\":" + DoubleToString(pnl,2) + ",\"accountId\":\"" + acct + "\"}";
   char post[], result[]; string rh = "";
   StringToCharArray(json, post, 0, StringLen(json));
   string headers = "Authorization: Bearer " + InpToken + "\r\nContent-Type: application/json\r\n";
   ResetLastError();
   WebRequest("POST", InpHenryUrl + "/api/mt5/report", headers, 5000, post, result, rh);
}

//+------------------------------------------------------------------+
bool HasOpenPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--){
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) == InpMagic && PositionGetString(POSITION_SYMBOL) == _Symbol) return true;
   }
   return false;
}
//+------------------------------------------------------------------+
