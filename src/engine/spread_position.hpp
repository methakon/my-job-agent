#ifndef HERMES_SPREAD_POSITION_HPP
#define HERMES_SPREAD_POSITION_HPP

#include <string>
#include <vector>
#include <map>
#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>

namespace hermes {

enum class SpreadType {
    BEAR_CALL_SPREAD, // Credit Call Spread: Sell Call (K1), Buy Call (K2, K2 > K1)
    BULL_PUT_SPREAD,  // Credit Put Spread: Sell Put (K1), Buy Put (K2, K2 < K1)
    IRON_CONDOR,      // 4-leg Credit: Bull Put Spread + Bear Call Spread
    SHORT_STRANGLE,   // Undefined-Risk Credit: Sell Put (OTM) + Sell Call (OTM)
    CUSTOM_SPREAD
};

enum class SpreadLegRole {
    SINGLE,
    SHORT_PRIMARY,    // The short leg sold to capture premium
    LONG_PROTECTIVE   // The long wing purchased to define maximum loss
};

inline std::string spread_type_to_string(SpreadType type) {
    switch (type) {
        case SpreadType::BEAR_CALL_SPREAD: return "BEAR_CALL_SPREAD";
        case SpreadType::BULL_PUT_SPREAD:  return "BULL_PUT_SPREAD";
        case SpreadType::IRON_CONDOR:      return "IRON_CONDOR";
        case SpreadType::SHORT_STRANGLE:   return "SHORT_STRANGLE";
        default:                           return "CUSTOM_SPREAD";
    }
}

inline std::string spread_leg_role_to_string(SpreadLegRole role) {
    switch (role) {
        case SpreadLegRole::SHORT_PRIMARY:  return "SHORT_PRIMARY";
        case SpreadLegRole::LONG_PROTECTIVE: return "LONG_PROTECTIVE";
        default:                            return "SINGLE";
    }
}

struct SpreadLeg {
    std::string instrument;       // Canonical symbol: e.g. "NSE:NIFTY26OCT25000CE"
    std::string side;             // "BUY" or "SELL"
    std::string option_type;      // "CE" or "PE"
    double strike{0.0};
    double entry_price{0.0};
    double current_price{0.0};
    double exit_price{0.0};
    int quantity{0};              // contracts (lots * lot_size)
    SpreadLegRole leg_role{SpreadLegRole::SINGLE};
    std::string trade_report_id;  // Links to cpp_trade_reports.id
    std::string status{"OPEN"};   // "OPEN", "CLOSED"
};

struct SpreadOrder {
    std::string spread_id;
    SpreadType spread_type{SpreadType::BEAR_CALL_SPREAD};
    std::string underlying{"NIFTY"};
    std::string expiry_date;
    std::vector<SpreadLeg> legs;
    int lot_size{25};
    int num_lots{1};
    double target_net_credit{0.0};     // INR premium per unit received
    double strike_width{0.0};          // Strike difference between short and long
    double max_loss_per_unit{0.0};     // strike_width - target_net_credit
    double max_profit_per_unit{0.0};   // target_net_credit
    double total_margin_required{0.0}; // Total margin in INR
    std::string algo_source{"PredictiveStrategyV1"};

    // Factory: 2-Leg Bear Call Spread (Credit)
    static SpreadOrder create_bear_call_spread(
        const std::string& underlying,
        const std::string& expiry,
        const std::string& short_inst,
        double short_strike,
        double short_price,
        const std::string& long_inst,
        double long_strike,
        double long_price,
        int num_lots,
        int lot_size = 25
    ) {
        SpreadOrder order;
        order.spread_id = "spd-bcs-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
        order.spread_type = SpreadType::BEAR_CALL_SPREAD;
        order.underlying = underlying;
        order.expiry_date = expiry;
        order.num_lots = std::max(1, num_lots);
        order.lot_size = lot_size;
        int total_qty = order.num_lots * order.lot_size;

        SpreadLeg short_leg;
        short_leg.instrument = short_inst;
        short_leg.side = "SELL";
        short_leg.option_type = "CE";
        short_leg.strike = short_strike;
        short_leg.entry_price = short_price;
        short_leg.quantity = total_qty;
        short_leg.leg_role = SpreadLegRole::SHORT_PRIMARY;

        SpreadLeg long_leg;
        long_leg.instrument = long_inst;
        long_leg.side = "BUY";
        long_leg.option_type = "CE";
        long_leg.strike = long_strike;
        long_leg.entry_price = long_price;
        long_leg.quantity = total_qty;
        long_leg.leg_role = SpreadLegRole::LONG_PROTECTIVE;

        order.legs.push_back(short_leg);
        order.legs.push_back(long_leg);

        order.target_net_credit = std::max(0.0, short_price - long_price);
        order.strike_width = std::abs(long_strike - short_strike);
        order.max_loss_per_unit = std::max(0.0, order.strike_width - order.target_net_credit);
        order.max_profit_per_unit = order.target_net_credit;
        order.total_margin_required = order.max_loss_per_unit * total_qty;

        return order;
    }

    // Factory: 2-Leg Bull Put Spread (Credit)
    static SpreadOrder create_bull_put_spread(
        const std::string& underlying,
        const std::string& expiry,
        const std::string& short_inst,
        double short_strike,
        double short_price,
        const std::string& long_inst,
        double long_strike,
        double long_price,
        int num_lots,
        int lot_size = 25
    ) {
        SpreadOrder order;
        order.spread_id = "spd-bps-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
        order.spread_type = SpreadType::BULL_PUT_SPREAD;
        order.underlying = underlying;
        order.expiry_date = expiry;
        order.num_lots = std::max(1, num_lots);
        order.lot_size = lot_size;
        int total_qty = order.num_lots * order.lot_size;

        SpreadLeg short_leg;
        short_leg.instrument = short_inst;
        short_leg.side = "SELL";
        short_leg.option_type = "PE";
        short_leg.strike = short_strike;
        short_leg.entry_price = short_price;
        short_leg.quantity = total_qty;
        short_leg.leg_role = SpreadLegRole::SHORT_PRIMARY;

        SpreadLeg long_leg;
        long_leg.instrument = long_inst;
        long_leg.side = "BUY";
        long_leg.option_type = "PE";
        long_leg.strike = long_strike;
        long_leg.entry_price = long_price;
        long_leg.quantity = total_qty;
        long_leg.leg_role = SpreadLegRole::LONG_PROTECTIVE;

        order.legs.push_back(short_leg);
        order.legs.push_back(long_leg);

        order.target_net_credit = std::max(0.0, short_price - long_price);
        order.strike_width = std::abs(short_strike - long_strike);
        order.max_loss_per_unit = std::max(0.0, order.strike_width - order.target_net_credit);
        order.max_profit_per_unit = order.target_net_credit;
        order.total_margin_required = order.max_loss_per_unit * total_qty;

        return order;
    }

    // Factory: 4-Leg Iron Condor
    static SpreadOrder create_iron_condor(
        const std::string& underlying,
        const std::string& expiry,
        const std::string& put_long_inst, double put_long_strike, double put_long_price,
        const std::string& put_short_inst, double put_short_strike, double put_short_price,
        const std::string& call_short_inst, double call_short_strike, double call_short_price,
        const std::string& call_long_inst, double call_long_strike, double call_long_price,
        int num_lots,
        int lot_size = 25
    ) {
        SpreadOrder order;
        order.spread_id = "spd-ic-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
        order.spread_type = SpreadType::IRON_CONDOR;
        order.underlying = underlying;
        order.expiry_date = expiry;
        order.num_lots = std::max(1, num_lots);
        order.lot_size = lot_size;
        int total_qty = order.num_lots * order.lot_size;

        // Put wing
        SpreadLeg p_long{put_long_inst, "BUY", "PE", put_long_strike, put_long_price, 0.0, 0.0, total_qty, SpreadLegRole::LONG_PROTECTIVE, "", "OPEN"};
        SpreadLeg p_short{put_short_inst, "SELL", "PE", put_short_strike, put_short_price, 0.0, 0.0, total_qty, SpreadLegRole::SHORT_PRIMARY, "", "OPEN"};
        // Call wing
        SpreadLeg c_short{call_short_inst, "SELL", "CE", call_short_strike, call_short_price, 0.0, 0.0, total_qty, SpreadLegRole::SHORT_PRIMARY, "", "OPEN"};
        SpreadLeg c_long{call_long_inst, "BUY", "CE", call_long_strike, call_long_price, 0.0, 0.0, total_qty, SpreadLegRole::LONG_PROTECTIVE, "", "OPEN"};

        order.legs = {p_long, p_short, c_short, c_long};

        double put_credit = std::max(0.0, put_short_price - put_long_price);
        double call_credit = std::max(0.0, call_short_price - call_long_price);
        order.target_net_credit = put_credit + call_credit;

        double put_width = std::abs(put_short_strike - put_long_strike);
        double call_width = std::abs(call_long_strike - call_short_strike);
        order.strike_width = std::max(put_width, call_width);
        order.max_loss_per_unit = std::max(0.0, order.strike_width - order.target_net_credit);
        order.max_profit_per_unit = order.target_net_credit;
        order.total_margin_required = order.max_loss_per_unit * total_qty;

        return order;
    }
};

struct SpreadPosition {
    std::string spread_id;
    SpreadType spread_type{SpreadType::BEAR_CALL_SPREAD};
    std::string underlying{"NIFTY"};
    std::vector<SpreadLeg> legs;
    int total_quantity{0};
    double entry_net_credit{0.0};
    double current_spread_cost{0.0}; // Cost to buy back the spread
    double unrealized_pnl{0.0};
    double realized_pnl{0.0};
    double max_loss_inr{0.0};
    double max_profit_inr{0.0};
    std::string status{"OPEN"};       // "OPEN", "CLOSED"
    std::string algo_source{"PredictiveStrategyV1"};
    std::string entry_timestamp;
    std::string exit_timestamp;
    std::string exit_reason;

    void update_market_prices(const std::map<std::string, double>& current_prices) {
        if (status != "OPEN") return;

        double current_short_sum = 0.0;
        double current_long_sum = 0.0;

        for (auto& leg : legs) {
            auto it = current_prices.find(leg.instrument);
            if (it != current_prices.end() && it->second > 0.0) {
                leg.current_price = it->second;
            }
            if (leg.side == "SELL") {
                current_short_sum += leg.current_price;
            } else if (leg.side == "BUY") {
                current_long_sum += leg.current_price;
            }
        }

        // Current cost to close the credit spread = (cost to buy back short) - (proceeds from selling long)
        current_spread_cost = std::max(0.0, current_short_sum - current_long_sum);

        // Unrealized P&L in INR = (entry_net_credit - current_spread_cost) * total_quantity
        unrealized_pnl = (entry_net_credit - current_spread_cost) * total_quantity;
    }

    // Returns true if position has reached defined profit target fraction (e.g. 50% max profit)
    bool check_profit_target_reached(double target_fraction = 0.50) const {
        if (status != "OPEN" || max_profit_inr <= 0.0) return false;
        return unrealized_pnl >= (target_fraction * max_profit_inr);
    }

    // Returns true if position has reached defined stop loss multiplier (e.g. 2.0x credit loss)
    bool check_stop_loss_reached(double stop_multiplier = 2.0) const {
        if (status != "OPEN" || max_profit_inr <= 0.0) return false;
        // Stop fires if loss reaches stop_multiplier * entry credit
        double max_allowed_loss = stop_multiplier * max_profit_inr;
        return unrealized_pnl <= -max_allowed_loss;
    }
};

} // namespace hermes

#endif // HERMES_SPREAD_POSITION_HPP
