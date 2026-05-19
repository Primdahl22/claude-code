/*******************************************************************************
* ECF - Panel Regression Analysis
* Data:    Stata Long sheet (ECF - Data.xlsx)
* Panel:   firm_id (entity) x year (2022-2025), T=4
*
* Structure
* ─────────────────────────────────────────────────────────────────────────────
*  0.  Housekeeping & import
*  1.  Variable construction & labelling
*  2.  Descriptive statistics
*  3.  Panel declaration & balance check
*  4.  Stationarity / unit-root tests  (Levin-Lin-Chu, Im-Pesaran-Shin)
*  5.  Correlation matrix & VIF
*  6.  Pooled OLS (baseline)
*  7.  Hausman specification test  (FE vs RE)
*  8.  Fixed-Effects (within) regressions
*       8a. Base model
*       8b. Full model
*       8c. Heteroskedasticity & serial-correlation robust SE
*  9.  Random-Effects (GLS) regression
* 10.  Between-Effects regression
* 11.  First-Differences regression
* 12.  Diagnostic tests on preferred FE model
* 13.  Robustness checks
*       13a. Winsorised variables
*       13b. Alternative leverage measure (market leverage)
*       13c. Year-interaction effects
* 14.  Export results tables  (esttab / outreg2)
* 15.  Diagnostic plots
*
* Dependent variable:   book_leverage  (total_debt / total_assets)
* Key independent vars: tangibility, profitability, market_to_book_ratio,
*                       sales (ln), intang_to_assets, ind_median_book_leverage
* Fixed effects:        firm_id, year
*
* Author:  [Your name]
* Date:    $S_DATE
*******************************************************************************/


/*─────────────────────────────────────────────────────────────────────────────
  0.  HOUSEKEEPING
─────────────────────────────────────────────────────────────────────────────*/

clear all
set more off
set linesize 120
version 17

* ── Set working directory (adjust to your folder) ───────────────────────────
* cd "C:/Users/yourname/Documents/ECF"

* ── Install required packages if missing ─────────────────────────────────────
* xtserial is built into Stata 16+ (no install needed)
* xttest3 is part of xttest2 on SSC
local pkgs "estout outreg2 winsor2 xtunitroot xtcd2 xttest2"
foreach pkg of local pkgs {
    capture which `pkg'
    if _rc != 0 {
        capture ssc install `pkg', replace
        if _rc != 0 di as error "WARNING: could not install `pkg' -- continue manually"
    }
}
* FIX 1: Moved capture log close and log using OUTSIDE the foreach loop
*        (they were erroneously inside, executing once per package).
capture log close
log using "ecf_panel_results.log", replace text


/*─────────────────────────────────────────────────────────────────────────────
  0b.  IMPORT FROM EXCEL
─────────────────────────────────────────────────────────────────────────────*/

* Adjust the path to match your file location
* FIX 2: Removed erroneous doubled double-quotes around path and sheet name.
import excel using "/Users/rasmus/Downloads/Book3.xlsx", ///
    sheet("Stata Long") firstrow clear


* Ensure numeric types (Excel sometimes imports numbers as strings)
destring firm_id year mktcap_thusd total_assets_thusd intang_to_assets ///
         tang_fixed_assets_thusd loans_st_debt_thusd lt_int_bearing_debt_thusd ///
         op_revenue_thusd ebitda_thusd total_equity_thusd closing_price_dec_usd ///
         outstanding_shares_dec_th total_debt_thusd book_leverage ///
         market_leverage ind_median_book_leverage ind_median_mkt_leverage ///
         tangibility market_to_book_ratio sales_thusd profitability ///
         ind_med_book_lev_avg_2224 ind_med_mkt_lev_avg_2224, replace force

* FIX 3: Added destring for avg variables that are labeled but were missing
*        from the original destring block.
destring tang_assets_avg_2224_thusd loans_st_avg_2224_thusd ///
         lt_debt_avg_2224_thusd shares_avg_2224_th, replace force

destring sic2, replace force


/*─────────────────────────────────────────────────────────────────────────────
  1.  VARIABLE CONSTRUCTION & LABELLING
─────────────────────────────────────────────────────────────────────────────*/

*── Natural log transformations (add 1 to avoid log(0)) ─────────────────────
gen ln_sales        = ln(sales_thusd + 1)
gen ln_total_assets = ln(total_assets_thusd + 1)
gen ln_mktcap       = ln(mktcap_thusd + 1)

*── Size proxy: log total assets ─────────────────────────────────────────────
gen size = ln_total_assets

*── Industry-adjusted leverage: firm leverage minus industry median ───────────
gen lev_adj_book   = book_leverage   - ind_median_book_leverage
gen lev_adj_market = market_leverage - ind_median_mkt_leverage

*── Variable labels ──────────────────────────────────────────────────────────
label variable firm_id                  "Firm identifier"
label variable year                     "Year"
label variable book_leverage            "Book leverage (D/A)"
label variable market_leverage          "Market leverage (D/(D+MktCap))"
label variable tangibility              "Tangibility (TangAssets/AvgAssets)"
label variable profitability            "Profitability (EBITDA/AvgAssets)"
label variable market_to_book_ratio     "Market-to-book ratio"
label variable intang_to_assets         "Intangibility ratio"
label variable ind_median_book_leverage "Industry median book leverage"
label variable ind_median_mkt_leverage  "Industry median market leverage"
label variable size                     "Firm size (ln total assets)"
label variable ln_sales                 "Log operating revenue"
label variable ln_mktcap                "Log market capitalisation"
label variable lev_adj_book             "Industry-adjusted book leverage"
label variable lev_adj_market           "Industry-adjusted market leverage"
label variable sic2                     "SIC 2-digit industry code"
label variable country_iso_code         "Country ISO code"
label variable total_debt_thusd         "Total debt (thUSD)"
label variable total_assets_thusd       "Total assets (thUSD)"
label variable tang_assets_avg_2224_thusd  "Avg tang fixed assets 2022-2024 (thUSD)"
label variable loans_st_avg_2224_thusd     "Avg ST loans/debt 2022-2024 (thUSD)"
label variable lt_debt_avg_2224_thusd      "Avg LT interest-bearing debt 2022-2024 (thUSD)"
label variable shares_avg_2224_th          "Avg outstanding shares 2022-2024 (thousands)"
label variable ind_med_book_lev_avg_2224   "Avg industry median book leverage 2022-2024"
* FIX 4: Added missing label for ind_med_mkt_lev_avg_2224 (was destringed but unlabelled).
label variable ind_med_mkt_lev_avg_2224    "Avg industry median market leverage 2022-2024"

/*─────────────────────────────────────────────────────────────────────────────
  2.  DESCRIPTIVE STATISTICS
─────────────────────────────────────────────────────────────────────────────*/

* FIX 5: Added required estpost summarize before esttab.
*        detail option is needed for p25/p50/p75 cells to be available.
estpost summarize book_leverage market_leverage tangibility profitability ///
    market_to_book_ratio intang_to_assets size ind_median_book_leverage ///
    ln_sales ln_mktcap, detail

esttab using "table_descriptives.csv", ///
    cells("mean(fmt(4)) sd(fmt(4)) min(fmt(4)) p25(fmt(4)) p50(fmt(4)) p75(fmt(4)) max(fmt(4)) count(fmt(0))") ///
    label noobs replace title("Table 1: Descriptive Statistics")

bysort year: summarize book_leverage market_leverage tangibility profitability ///
    market_to_book_ratio size

pwcorr book_leverage tangibility profitability market_to_book_ratio ///
    intang_to_assets size ind_median_book_leverage, star(0.05) print(0.10) listwise


/*─────────────────────────────────────────────────────────────────────────────
  3.  PANEL DECLARATION & BALANCE CHECK
─────────────────────────────────────────────────────────────────────────────*/

xtset firm_id year, yearly
xtdescribe

tabstat firm_id, by(year) stat(count)

misstable summarize book_leverage tangibility profitability ///
    market_to_book_ratio intang_to_assets size ind_median_book_leverage

*── Create lagged variables AFTER xtset ──────────────────────────────────────
foreach var in book_leverage market_leverage tangibility profitability ///
               market_to_book_ratio intang_to_assets size ///
               ind_median_book_leverage total_debt_thusd total_assets_thusd {
    gen L_`var' = L.`var'
    label variable L_`var' "L. `var'"
}


/*─────────────────────────────────────────────────────────────────────────────
  4.  PANEL UNIT-ROOT TESTS
*   Short panel (T=4): LLC and Im-Pesaran-Shin
*   H0: all panels contain a unit root
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== UNIT ROOT TESTS ===="

foreach var in book_leverage tangibility profitability market_to_book_ratio ///
               intang_to_assets size {
    di _n "--- `var' ---"
    xtunitroot llc `var', lags(aic 4) kernel(bartlett 3) demean
    xtunitroot ips `var', lags(aic 4) demean
}


/*─────────────────────────────────────────────────────────────────────────────
  5.  MULTICOLLINEARITY CHECK (VIF via pooled OLS)
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== VIF CHECK ===="
reg book_leverage L_tangibility L_profitability L_market_to_book_ratio ///
    L_intang_to_assets L_size L_ind_median_book_leverage i.year
estat vif


/*─────────────────────────────────────────────────────────────────────────────
  6.  POOLED OLS (baseline - ignores firm heterogeneity)
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== POOLED OLS ===="

eststo pols_base: regress book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, ///
    vce(cluster firm_id)

eststo pols_full: regress book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year i.sic2, ///
    vce(cluster firm_id)

esttab pols_base pols_full, star(* 0.10 ** 0.05 *** 0.01) ///
    b(4) se(4) ar2 scalars("N" "r2" "F") label title("Pooled OLS") compress


/*─────────────────────────────────────────────────────────────────────────────
  7.  HAUSMAN TEST: Fixed Effects vs Random Effects
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== HAUSMAN TEST ===="

quietly xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, fe
estimates store fe_hausman

quietly xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, re
estimates store re_hausman

* H0: RE is consistent (prefer RE); reject H0 => use FE
hausman fe_hausman re_hausman, sigmamore

*── Mundlak test (robust alternative to Hausman) ────────────────────────────
foreach var in L_tangibility L_profitability L_market_to_book_ratio ///
               L_intang_to_assets L_size L_ind_median_book_leverage {
    bysort firm_id: egen mean_`var' = mean(`var')
}

xtreg book_leverage L_tangibility L_profitability L_market_to_book_ratio ///
    L_intang_to_assets L_size L_ind_median_book_leverage i.year ///
    mean_L_tangibility mean_L_profitability mean_L_market_to_book_ratio ///
    mean_L_intang_to_assets mean_L_size mean_L_ind_median_book_leverage, re

di "Mundlak test - H0: group means jointly = 0 (prefer RE)"
testparm mean_L_tangibility mean_L_profitability mean_L_market_to_book_ratio ///
         mean_L_intang_to_assets mean_L_size mean_L_ind_median_book_leverage


/*─────────────────────────────────────────────────────────────────────────────
  8.  FIXED-EFFECTS (WITHIN) REGRESSIONS
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== FIXED EFFECTS REGRESSIONS ===="

*── 8a. Base model: one-period lags + year FE ────────────────────────────────
eststo fe_base: xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, ///
    fe vce(cluster firm_id)

di "Within R2 = " e(r2_w) "  Between R2 = " e(r2_b) "  Overall R2 = " e(r2_o)
di "Rho (share of variance from firm FE) = " e(rho)

*── 8b. Full model: base regressors + lagged market leverage control ─────────
* FIX 6: fe_full was identical to fe_base (copy-paste error).
*        Added L_market_leverage per the comment "add market-leverage controls".
eststo fe_full: xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage L_market_leverage i.year, ///
    fe vce(cluster firm_id)

*── 8c. Two-way FE with robust SE ───────────────────────────────────────────
eststo fe_2way: xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, ///
    fe vce(robust)

* Joint significance of year dummies
testparm i.year


/*─────────────────────────────────────────────────────────────────────────────
  9.  RANDOM-EFFECTS (GLS) REGRESSION
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== RANDOM EFFECTS REGRESSION ===="

eststo re_base: xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, ///
    re vce(cluster firm_id) theta

di "Theta (GLS weight) = " e(theta)

* Breusch-Pagan LM test - H0: var(u_i)=0, no random effects
quietly xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, re
xttest0


/*─────────────────────────────────────────────────────────────────────────────
 10.  BETWEEN-EFFECTS REGRESSION
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== BETWEEN EFFECTS REGRESSION ===="

eststo be_base: xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage, be


/*─────────────────────────────────────────────────────────────────────────────
 11.  FIRST-DIFFERENCES REGRESSION
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== FIRST DIFFERENCES REGRESSION ===="

foreach var in book_leverage tangibility profitability market_to_book_ratio ///
               intang_to_assets size ind_median_book_leverage {
    gen D_`var' = D.`var'
    label variable D_`var' "Delta `var'"
}

eststo fd_base: reg D_book_leverage D_tangibility D_profitability ///
    D_market_to_book_ratio D_intang_to_assets D_size ///
    D_ind_median_book_leverage i.year, ///
    vce(cluster firm_id) noconstant


/*─────────────────────────────────────────────────────────────────────────────
 12.  DIAGNOSTIC TESTS ON PREFERRED FE MODEL
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== DIAGNOSTIC TESTS ===="

* xttest3 requires plain FE (no vce); run separately from cluster-robust model
quietly xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size L_ind_median_book_leverage i.year, fe

* 12a. Modified Wald test for group-wise heteroskedasticity
*      H0: sigma_i^2 = sigma^2 for all i (homoskedastic)
xttest3

* 12b. Wooldridge test for AR(1) serial correlation in idiosyncratic errors
*      H0: no first-order autocorrelation
xtserial book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size L_ind_median_book_leverage

* 12c. Pesaran CD test for cross-sectional dependence
*      H0: errors are cross-sectionally independent
quietly xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, fe
xtcd2


/*─────────────────────────────────────────────────────────────────────────────
 13.  ROBUSTNESS CHECKS
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== ROBUSTNESS CHECKS ===="

*── 13a. Winsorise at 1st and 99th percentiles ───────────────────────────────
winsor2 book_leverage tangibility profitability market_to_book_ratio ///
        intang_to_assets size, suffix(_w) cuts(1 99)

* Create lagged winsorised variables
gen L_book_leverage_w        = L.book_leverage_w
gen L_tangibility_w          = L.tangibility_w
gen L_profitability_w        = L.profitability_w
gen L_market_to_book_ratio_w = L.market_to_book_ratio_w
gen L_intang_to_assets_w     = L.intang_to_assets_w
gen L_size_w                 = L.size_w

eststo fe_winsor: xtreg book_leverage_w L_tangibility_w L_profitability_w ///
    L_market_to_book_ratio_w L_intang_to_assets_w L_size_w ///
    L_ind_median_book_leverage i.year, fe vce(cluster firm_id)

*── 13b. Dependent variable: market leverage ─────────────────────────────────
eststo fe_mktlev: xtreg market_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_mkt_leverage i.year, ///
    fe vce(cluster firm_id)

*── 13c. Year x tangibility interaction ──────────────────────────────────────
gen tang_x_year = L_tangibility * year
label variable tang_x_year "Tangibility x Year"

eststo fe_interact: xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage tang_x_year i.year, ///
    fe vce(cluster firm_id)

testparm tang_x_year


/*─────────────────────────────────────────────────────────────────────────────
 14.  EXPORT RESULTS TABLES
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== EXPORTING TABLES ===="

*── Main results table ───────────────────────────────────────────────────────
esttab pols_base fe_base fe_full re_base be_base fd_base ///
    using "table_main_results.csv", replace ///
    star(* 0.10 ** 0.05 *** 0.01) b(4) se(4) ///
    stats(N r2_w r2_b r2_o rho, ///
        fmt(%9.0f %9.4f %9.4f %9.4f %9.4f) ///
        labels("Observations" "R2 Within" "R2 Between" "R2 Overall" "Rho")) ///
    label ///
    title("Table 2: Panel Regression Results - Dependent: Book Leverage") ///
    mtitles("Pooled OLS" "FE Base" "FE Full" "RE" "BE" "FD") ///
    note("Cluster-robust SE in parentheses (firm level). * p<0.10, ** p<0.05, *** p<0.01")

*── Robustness table ─────────────────────────────────────────────────────────
esttab fe_base fe_winsor fe_mktlev fe_interact fe_2way ///
    using "table_robustness.csv", replace ///
    star(* 0.10 ** 0.05 *** 0.01) b(4) se(4) ///
    stats(N r2_w rho, ///
        fmt(%9.0f %9.4f %9.4f) ///
        labels("Observations" "R2 Within" "Rho")) ///
    label ///
    title("Table 3: Robustness Checks") ///
    mtitles("FE Base" "Winsorised" "Mkt Leverage" "Interaction" "2-Way FE") ///
    note("Cluster-robust SE (firm level) except 2-Way FE (robust SE). * p<0.10, ** p<0.05, *** p<0.01")


/*─────────────────────────────────────────────────────────────────────────────
 15.  DIAGNOSTIC PLOTS
─────────────────────────────────────────────────────────────────────────────*/

di _n "==== DIAGNOSTIC PLOTS ===="

quietly xtreg book_leverage L_tangibility L_profitability ///
    L_market_to_book_ratio L_intang_to_assets L_size ///
    L_ind_median_book_leverage i.year, fe

predict double uhat, e
predict double u_i, u
predict double yhat, xbu

* Residuals vs Fitted
twoway (scatter uhat yhat, msize(vtiny) mcolor(navy%40)) ///
       (lowess uhat yhat, lcolor(red) lwidth(medthin)), ///
    yline(0, lcolor(black) lpattern(dash)) ///
    title("Residuals vs Fitted Values") ///
    xtitle("Fitted values") ytitle("Residuals") ///
    name(resid_fitted, replace) nodraw
graph export "plot_resid_fitted.png", as(png) replace

* Residual distribution
histogram uhat, normal kdensity ///
    title("Distribution of Residuals (FE model)") ///
    xtitle("Residual") ytitle("Density") ///
    name(hist_resid, replace) nodraw
graph export "plot_resid_hist.png", as(png) replace

* Normal probability plot
qnorm uhat, ///
    title("Normal Probability Plot - FE Residuals") ///
    name(qnorm_resid, replace) nodraw
graph export "plot_qnorm.png", as(png) replace

* Firm FE distribution
histogram u_i, normal ///
    title("Distribution of Firm Fixed Effects") ///
    xtitle("Firm FE") ytitle("Density") ///
    name(hist_fe, replace) nodraw
graph export "plot_firm_fe_dist.png", as(png) replace

* Mean leverage by year
preserve
    collapse (mean) mean_lev = book_leverage (sd) sd_lev = book_leverage, by(year)
    gen lb = mean_lev - 1.96*sd_lev
    gen ub = mean_lev + 1.96*sd_lev
    twoway (rcap lb ub year, lcolor(navy%60)) ///
           (connected mean_lev year, lcolor(navy) mcolor(navy) msize(small)), ///
        title("Mean Book Leverage by Year (+/- 1.96 SD)") ///
        xtitle("Year") ytitle("Mean Book Leverage") ///
        xlabel(2022(1)2025) legend(off) ///
        name(lev_by_year, replace) nodraw
    graph export "plot_leverage_trend.png", as(png) replace
restore

drop uhat u_i yhat


/*─────────────────────────────────────────────────────────────────────────────
 16.  SUMMARY
─────────────────────────────────────────────────────────────────────────────*/

di _n as text "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
di as text    " SPECIFICATION SUMMARY"
di as text    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
di as text    " Panel:          3,325 firms x 4 years (2022-2025)"
di as text    " Dependent var:  book_leverage  (total_debt / total_assets)"
di as text    " Preferred spec: Two-way FE (firm + year), lagged regressors"
di as text    "                 Cluster-robust SE at firm level"
di as text    " Key tests:"
di as text    "   Hausman        => FE vs RE"
di as text    "   Breusch-Pagan  => RE vs Pooled OLS"
di as text    "   Mundlak        => Robust FE vs RE"
di as text    "   LLC / IPS      => Unit roots"
di as text    "   Wald (xttest3) => Heteroskedasticity"
di as text    "   Wooldridge     => Serial correlation"
di as text    "   Pesaran CD     => Cross-sectional dependence"
di as text    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

log close
