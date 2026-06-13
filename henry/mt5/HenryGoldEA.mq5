//+------------------------------------------------------------------+
//|                                                  HenryGoldEA.mq5  |
//|   Henry The Hoover — gold signal executor for MetaTrader 5.       |
//|                                                                   |
//|   Polls Henry for confirmed GOLD setups, places a market order    |
//|   with a hard SL + TP (the safety net), and reports every         |
//|   fill / TP / SL / close back to Henry.                           |
//|                                                                   |
//|   Phase 1: admin account. BE/close management (the /manage        |
//|   channel) is added in Phase 1.5 — for now the broker-side        |
//|   SL/TP protect the trade.                                        |
//|                                                                   |
//|   *** TEST ON A DEMO ACCOUNT FIRST. InpEnableTrading is OFF by    |
//|   default — flip it on only after you've watched it on demo. ***  |
//+------------------------------------------------------------------+
#property copyright "Henry The Hoover"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- Inputs (configured when you attach the EA to a chart) ----------
input string  InpHenryUrl      = "https://henrythehoover.com"; // Henry base URL (must be whitelisted, see README)
input string  InpToken         = "";        // HENRY_MT5_TOKEN (must match Railway)
input string  InpSymbol        = "XAUUSD";  // YOUR broker's gold symbol (XAUUSD / GOLD / XAUUSD.r ...)
input double  InpRiskPct       = 1.0;       // % of balance risked per trade
input double  InpFixedRiskUsd  = 0;         // if > 0, risk this fixed $ instead of the %
input double  InpMaxLots       = 1.0;       // hard safety cap on position size
input int     InpPollSeconds   = 10;        // how often to poll Henry
input long    InpMagic         = 760520;    // magic number tagging this EA's trades
input int     InpSlippage      = 30;        // max price deviation (points)
input bool    InpEnableTrading = false;     // MASTER SWITCH — start OFF

//--- State ----------------------------------------------------------
CTrade  trade;
string  g_cursor      = "";                 // last signal ts processed (echoed as ?since)
string  g_cursorFile  = "HenryGoldEA_cursor.txt";

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(InpSymbol);

   if(!SymbolSelect(InpSymbol, true))
      Print("WARN: could not select symbol ", InpSymbol, " — check the exact name in Market Watch");

   LoadCursor();
   EventSetTimer(MathMax(3, InpPollSeconds));

   PrintFormat("HenryGoldEA started | symbol=%s | trading=%s | risk=%s",
               InpSymbol,
               (InpEnableTrading ? "ON" : "OFF (demo/observe)"),
               (InpFixedRiskUsd > 0 ? "$"+DoubleToString(InpFixedRiskUsd,2) : DoubleToString(InpRiskPct,2)+"%"));
   if(InpToken == "") Print("ERROR: InpToken is empty — set HENRY_MT5_TOKEN.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void OnTimer()
{
   PollSignals();
}

//+------------------------------------------------------------------+
//| Pull new gold signals (CSV) and act on any not already open      |
//+------------------------------------------------------------------+
void PollSignals()
{
   string url = InpHenryUrl + "/api/mt5/signals?format=csv";
   if(g_cursor != "") url += "&since=" + UrlEncode(g_cursor);

   string body;
   if(!HttpGet(url, body)) return;
   if(StringLen(body) == 0) return;

   string lines[];
   int n = StringSplit(body, '\n', lines);
   for(int i = 0; i < n; i++)
   {
      string line = lines[i];
      StringTrimRight(line); StringTrimLeft(line);
      if(StringLen(line) == 0) continue;

      string f[];
      if(StringSplit(line, ',', f) < 6) continue;
      string id    = f[0];
      string side  = f[1];
      double entry = StringToDouble(f[2]);
      double sl    = StringToDouble(f[3]);
      double tp    = StringToDouble(f[4]);
      string ts    = f[5];

      if(!AlreadyOpen(id)) PlaceTrade(id, side, entry, sl, tp);

      // advance cursor to the newest ts seen
      if(StringCompare(ts, g_cursor) > 0) { g_cursor = ts; SaveCursor(); }
   }
}

//+------------------------------------------------------------------+
//| Place a market order, anchoring SL/TP DISTANCES to our fill so    |
//| the WEEX<->broker gold basis is irrelevant.                       |
//+------------------------------------------------------------------+
void PlaceTrade(string id, string side, double entry, double sl, double tp)
{
   bool isBuy = (side == "buy");
   double slDist = MathAbs(entry - sl);
   double tpDist = MathAbs(tp - entry);
   if(slDist <= 0) { Print("skip ", id, " — zero stop distance"); return; }

   double lots = ComputeLots(slDist);
   if(lots <= 0) { Print("skip ", id, " — lot size computed 0"); return; }

   int    digits = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);
   double stopsLvl = (double)SymbolInfoInteger(InpSymbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
   double minDist  = MathMax(slDist, stopsLvl);   // respect broker min-stop on the SL side

   double px = isBuy ? SymbolInfoDouble(InpSymbol, SYMBOL_ASK)
                     : SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double slP = isBuy ? px - minDist : px + minDist;
   double tpP = isBuy ? px + tpDist  : px - tpDist;
   slP = NormalizeDouble(slP, digits);
   tpP = NormalizeDouble(tpP, digits);

   if(!InpEnableTrading)
   {
      PrintFormat("[observe] would %s %.2f %s @ %.2f SL %.2f TP %.2f (signal %s)",
                  side, lots, InpSymbol, px, slP, tpP, id);
      return;
   }

   bool ok = isBuy ? trade.Buy(lots, InpSymbol, 0.0, slP, tpP, id)
                   : trade.Sell(lots, InpSymbol, 0.0, slP, tpP, id);
   if(ok)
   {
      double fill = trade.ResultPrice();
      ReportEvent(id, "filled", fill, lots, (string)trade.ResultOrder(), 0.0, side);
      PrintFormat("OPENED %s %.2f %s @ %.2f (signal %s)", side, lots, InpSymbol, fill, id);
   }
   else PrintFormat("ORDER FAILED %s %s: ret=%d %s", side, id, trade.ResultRetcode(), trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
//| Lot size from risk money / money-at-risk-per-lot, using the       |
//| symbol's own tick value — broker/contract-agnostic.               |
//+------------------------------------------------------------------+
double ComputeLots(double slDist)
{
   double riskMoney = (InpFixedRiskUsd > 0) ? InpFixedRiskUsd
                                            : AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPct / 100.0;
   double tickVal = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSz  = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickVal <= 0 || tickSz <= 0) { Print("ERROR: bad tick value/size for ", InpSymbol); return 0; }

   double moneyPerLot = (slDist / tickSz) * tickVal;
   if(moneyPerLot <= 0) return 0;
   double lots = riskMoney / moneyPerLot;

   double step = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double maxL = MathMin(SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MAX), InpMaxLots);
   if(step > 0) lots = MathFloor(lots / step) * step;
   if(lots < minL) lots = minL;        // floor to broker min (note: raises risk above target on tiny accounts)
   if(lots > maxL) lots = maxL;        // safety cap
   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//| Report TP / SL / close back to Henry when our position exits.     |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   ulong deal = trans.deal;
   if(deal == 0 || !HistoryDealSelect(deal)) return;
   if(HistoryDealGetInteger(deal, DEAL_MAGIC) != InpMagic) return;
   if(HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) return;   // closing deal only

   string id    = HistoryDealGetString(deal, DEAL_COMMENT);   // we stamped the signal id as the comment
   double price = HistoryDealGetDouble(deal, DEAL_PRICE);
   double pnl   = HistoryDealGetDouble(deal, DEAL_PROFIT)
                + HistoryDealGetDouble(deal, DEAL_SWAP)
                + HistoryDealGetDouble(deal, DEAL_COMMISSION);
   double lots  = HistoryDealGetDouble(deal, DEAL_VOLUME);
   long   reason = HistoryDealGetInteger(deal, DEAL_REASON);

   string evt = "closed";
   if(reason == DEAL_REASON_TP) evt = "tp";
   else if(reason == DEAL_REASON_SL) evt = "sl";

   if(StringLen(id) > 0)
      ReportEvent(id, evt, price, lots, (string)deal, pnl, "");
}

//+------------------------------------------------------------------+
//| POST an execution event to Henry (manual JSON build).             |
//+------------------------------------------------------------------+
void ReportEvent(string signalId, string event, double price, double lots, string ticket, double pnl, string side)
{
   string acct = (string)AccountInfoInteger(ACCOUNT_LOGIN);
   string json = "{";
   json += "\"signalId\":\"" + signalId + "\",";
   json += "\"event\":\"" + event + "\",";
   json += "\"symbol\":\"" + InpSymbol + "\",";
   if(side != "") json += "\"side\":\"" + side + "\",";
   json += "\"price\":" + DoubleToString(price, 2) + ",";
   json += "\"lots\":" + DoubleToString(lots, 2) + ",";
   json += "\"ticket\":\"" + ticket + "\",";
   json += "\"pnl\":" + DoubleToString(pnl, 2) + ",";
   json += "\"accountId\":\"" + acct + "\"}";

   string body;
   HttpPost(InpHenryUrl + "/api/mt5/report", json, body);
}

//+------------------------------------------------------------------+
//| HTTP helpers (WebRequest). URL must be whitelisted in terminal.   |
//+------------------------------------------------------------------+
bool HttpGet(string url, string &outBody)
{
   char post[], result[];
   string rh = "";
   string headers = "Authorization: Bearer " + InpToken + "\r\n";
   ResetLastError();
   int code = WebRequest("GET", url, headers, 5000, post, result, rh);
   if(code == -1)
   {
      PrintFormat("WebRequest GET err=%d — add %s to Tools>Options>Expert Advisors>Allow WebRequest", GetLastError(), InpHenryUrl);
      return false;
   }
   if(code != 200) { PrintFormat("GET %d from Henry", code); return false; }
   outBody = CharArrayToString(result);
   return true;
}

bool HttpPost(string url, string json, string &outBody)
{
   char post[], result[];
   StringToCharArray(json, post, 0, StringLen(json));   // no trailing null
   string rh = "";
   string headers = "Authorization: Bearer " + InpToken + "\r\nContent-Type: application/json\r\n";
   ResetLastError();
   int code = WebRequest("POST", url, headers, 5000, post, result, rh);
   if(code == -1) { PrintFormat("WebRequest POST err=%d (whitelist %s)", GetLastError(), InpHenryUrl); return false; }
   outBody = CharArrayToString(result);
   if(code != 200) PrintFormat("POST %d to Henry: %s", code, outBody);
   return (code == 200);
}

//+------------------------------------------------------------------+
//| Helpers                                                           |
//+------------------------------------------------------------------+
// true if we already have an open position for this signal id (dedup)
bool AlreadyOpen(string id)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(PositionGetString(POSITION_COMMENT) == id) return true;
   }
   return false;
}

string UrlEncode(string s)
{
   string out = "";
   for(int i = 0; i < StringLen(s); i++)
   {
      ushort c = StringGetCharacter(s, i);
      if((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
         c == '-' || c == '_' || c == '.' || c == '~')
         out += ShortToString(c);
      else
         out += StringFormat("%%%02X", c);
   }
   return out;
}

void SaveCursor()
{
   int h = FileOpen(g_cursorFile, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h != INVALID_HANDLE) { FileWriteString(h, g_cursor); FileClose(h); }
}

void LoadCursor()
{
   if(!FileIsExist(g_cursorFile)) return;
   int h = FileOpen(g_cursorFile, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h != INVALID_HANDLE) { g_cursor = FileReadString(h); FileClose(h); }
}
//+------------------------------------------------------------------+
