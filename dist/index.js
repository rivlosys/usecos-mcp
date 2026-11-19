#!/usr/bin/env node

// packages/mcp-server/src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// packages/mcp-server/src/tools.ts
import { z } from "zod";

// app/mortgage/types.ts
function monthlyRateFromSemiAnnual(rPct) {
  return Math.pow(Math.pow(1 + rPct / 100 / 2, 2), 1 / 12) - 1;
}
function graduatedTax(price, limits, rates) {
  let tax = 0;
  let remaining = price;
  let prev = 0;
  for (let i = 0; i < limits.length; i++) {
    if (remaining <= 0) break;
    const taxable = Math.min(remaining, limits[i] - prev);
    tax += taxable * rates[i];
    remaining -= taxable;
    prev = limits[i];
  }
  if (remaining > 0 && rates.length > limits.length) {
    tax += remaining * rates[rates.length - 1];
  }
  return tax;
}
function calcLandTransferTax(price, province) {
  const p = Math.max(0, price);
  switch (province) {
    case "ON":
      return graduatedTax(p, [55e3, 25e4, 4e5, 2e6], [5e-3, 0.01, 0.015, 0.02, 0.025]);
    case "BC":
      return graduatedTax(p, [2e5, 2e6, 3e6], [0.01, 0.02, 0.03, 0.05]);
    case "QC":
      return graduatedTax(p, [5e4, 25e4], [5e-3, 0.01, 0.015]);
    case "MB":
      return graduatedTax(p, [3e4, 9e4, 15e4, 2e5], [0, 5e-3, 0.01, 0.015, 0.02]);
    case "NS":
      return p * 0.015;
    case "NB":
      return p * 0.01;
    case "PE":
      return p * 0.01;
    case "NL":
      return p * 6e-3;
    case "AB":
    case "SK":
    case "YT":
    case "NT":
    case "NU":
    default:
      return 0;
  }
}
function calcCMHC(price, downPayment, mode) {
  if (mode !== "purchase" || price >= 15e5) return 0;
  const dpPct = price > 0 ? downPayment / price * 100 : 0;
  if (dpPct >= 20) return 0;
  const loanBase = Math.max(0, price - downPayment);
  const insRate = dpPct < 10 ? 0.04 : dpPct < 15 ? 0.031 : 0.028;
  return loanBase * insRate;
}

// lib/utils.ts
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// app/mortgage/engine/calculate.ts
function runAmortization(loanAmount, mRate, totalMonths, payment, lumpSumAmount, lumpSumMonth) {
  const amortSchedule = [];
  let remBal = loanAmount;
  let monthCount = 0;
  for (let m = 1; m <= totalMonths && remBal > 0.01; m++) {
    const intPart = mRate > 0 ? remBal * mRate : 0;
    let princPart = Math.min(remBal, payment - intPart);
    remBal = Math.max(0, remBal - princPart);
    if (lumpSumAmount > 0 && m === lumpSumMonth) {
      remBal = Math.max(0, remBal - lumpSumAmount);
    }
    amortSchedule.push({ year: Math.ceil(m / 12), month: m, payment, principal: Math.round(princPart * 100) / 100, interest: Math.round(intPart * 100) / 100, balance: remBal });
    monthCount = m;
  }
  return { schedule: amortSchedule, actualMonths: monthCount };
}
function calculateMortgage(input, rateOverride) {
  const { price, downPayment, rate, amort, extraPayment, frequency, province, mode, lumpSumAmount, lumpSumYear } = input;
  const pPrice = safeNum(price);
  const pRate = rateOverride ?? safeNum(rate);
  const pAmort = Math.max(0.5, safeNum(amort));
  const dpAmount = safeNum(downPayment);
  const loanBase = mode === "purchase" ? Math.max(0, pPrice - dpAmount) : Math.max(0, pPrice);
  const dpPct = pPrice > 0 ? dpAmount / pPrice * 100 : 0;
  const cmhc = calcCMHC(pPrice, dpAmount, mode);
  let loanAmount = loanBase;
  if (mode === "purchase" && pPrice < 15e5 && dpPct < 20) {
    loanAmount = loanBase + cmhc;
  }
  const mRate = monthlyRateFromSemiAnnual(pRate);
  const totalMonths = Math.max(1, Math.round(pAmort * 12));
  const baseMonthlyPayment = mRate > 0 ? loanAmount * mRate / (1 - Math.pow(1 + mRate, -totalMonths)) : loanAmount / totalMonths;
  const extra = safeNum(extraPayment);
  const paymentWithExtra = baseMonthlyPayment + extra;
  const getBalance = (n) => {
    if (mRate === 0) return Math.max(0, loanAmount - paymentWithExtra * n);
    return Math.max(0, loanAmount * Math.pow(1 + mRate, n) - paymentWithExtra / mRate * (Math.pow(1 + mRate, n) - 1));
  };
  let actualMonths = totalMonths;
  if (extra > 0 && mRate > 0) {
    const val = 1 - mRate * loanAmount / paymentWithExtra;
    if (val > 0) actualMonths = Math.min(totalMonths, -Math.log(val) / Math.log(1 + mRate));
  }
  const lumpSumAmt = safeNum(lumpSumAmount);
  const lumpSumMo = lumpSumYear > 0 && lumpSumAmt > 0 ? Math.min(totalMonths, Math.round(lumpSumYear * 12)) : 0;
  const { schedule: amortSchedule, actualMonths: actualWithLump } = runAmortization(loanAmount, mRate, totalMonths, paymentWithExtra, lumpSumAmt, lumpSumMo);
  actualMonths = actualWithLump;
  const { actualMonths: baseMonths } = runAmortization(loanAmount, mRate, totalMonths, paymentWithExtra, 0, 0);
  const baseTotalCost = paymentWithExtra * baseMonths;
  const lumpSumTotalCost = paymentWithExtra * actualMonths + lumpSumAmt;
  const lumpSumInterestSaved = Math.max(0, Math.round((baseTotalCost - loanAmount) * 100) / 100 - Math.round((lumpSumTotalCost - loanAmount) * 100) / 100);
  const lumpSumYearsShortened = Math.max(0, Math.round((baseMonths - actualMonths) / 12 * 10) / 10);
  const balanceYear5 = getBalance(60);
  const balanceYear10 = getBalance(120);
  const totalCost = paymentWithExtra * actualMonths + lumpSumAmt;
  let freqPayment = paymentWithExtra;
  switch (frequency) {
    case "biweekly":
      freqPayment = paymentWithExtra * 12 / 26;
      break;
    case "weekly":
      freqPayment = paymentWithExtra * 12 / 52;
      break;
    case "biweekly_acc":
      freqPayment = paymentWithExtra / 2;
      break;
    case "weekly_acc":
      freqPayment = paymentWithExtra / 4;
      break;
  }
  const qualifyingRate = Math.max(5.25, pRate + 2);
  const qrMonthly = monthlyRateFromSemiAnnual(qualifyingRate);
  const qrPayment = qrMonthly > 0 ? loanAmount * qrMonthly / (1 - Math.pow(1 + qrMonthly, -totalMonths)) : loanAmount / totalMonths;
  const ltt = calcLandTransferTax(pPrice, province);
  const propertyTax = pPrice * (PROV_TAX_RATES[province] ?? 0.015) / 12;
  const monthlyCost = freqPayment + propertyTax;
  return {
    payment: freqPayment,
    loan: loanAmount,
    interest: Math.round((totalCost - loanAmount) * 100) / 100,
    total: Math.round(totalCost * 100) / 100,
    cmhc,
    dpPct,
    basePayment: baseMonthlyPayment,
    monthlyRate: mRate,
    balanceYear5: Math.round(balanceYear5 * 100) / 100,
    balanceYear10: Math.round(balanceYear10 * 100) / 100,
    amortSchedule,
    yearsToPayoff: Math.ceil(actualMonths / 12 * 10) / 10,
    qualifyingRate,
    maxQualifying: qrPayment > 0 ? Math.round(qrPayment * 12 / 0.39) : 0,
    monthlyCost,
    propertyTax,
    landTransferTax: ltt,
    lumpSumInterestSaved,
    lumpSumYearsShortened
  };
}
var PROV_TAX_RATES = {
  ON: 0.015,
  BC: 0.012,
  AB: 0.014,
  QC: 0.016,
  SK: 0.017,
  MB: 0.018,
  NS: 0.016,
  NB: 0.015,
  PE: 0.015,
  NL: 0.014,
  YT: 0.012,
  NT: 0.013,
  NU: 0.013
};

// app/mortgage/engine/renewal.ts
var roundCents = (value) => Math.round(value * 100) / 100;
var cleanNumber = (value) => Number.isFinite(value) ? Math.max(0, value) : 0;
function sameMoney(a, b) {
  return Math.abs(a - b) < 5e-3;
}
function paymentsPerYearForFrequency(frequency) {
  switch (frequency) {
    case "weekly":
    case "accelerated_weekly":
      return 52;
    case "biweekly":
    case "accelerated_biweekly":
      return 26;
    default:
      return 12;
  }
}
function effectivePeriodicRate(annualRatePercent, paymentsPerYear, compounding) {
  if (annualRatePercent <= 0) return 0;
  if (compounding === "monthly") {
    return Math.pow(1 + annualRatePercent / 100 / 12, 12 / paymentsPerYear) - 1;
  }
  return Math.pow(1 + annualRatePercent / 100 / 2, 2 / paymentsPerYear) - 1;
}
function amortizingPayment(balance, periodicRate, amortizationPeriods) {
  if (amortizationPeriods <= 0) return balance;
  if (periodicRate <= 0) return balance / amortizationPeriods;
  return balance * periodicRate / (1 - Math.pow(1 + periodicRate, -amortizationPeriods));
}
function compoundingUsed(input) {
  return input.compounding === "not_sure" ? "semi_annual" : input.compounding;
}
function scheduledPaymentForOffer(position, input) {
  const balance = cleanNumber(position.renewalBalance) + cleanNumber(input.additionalBorrowing);
  const amortYears = cleanNumber(input.newAmortizationYears);
  const usedCompounding = compoundingUsed(input);
  if (input.paymentFrequency === "accelerated_biweekly" || input.paymentFrequency === "accelerated_weekly") {
    const monthlyRate = effectivePeriodicRate(
      cleanNumber(input.ratePercent),
      12,
      usedCompounding
    );
    const monthlyPayment = amortizingPayment(balance, monthlyRate, amortYears * 12);
    return input.paymentFrequency === "accelerated_biweekly" ? monthlyPayment / 2 : monthlyPayment / 4;
  }
  const paymentsPerYear = paymentsPerYearForFrequency(input.paymentFrequency);
  const periodicRate = effectivePeriodicRate(
    cleanNumber(input.ratePercent),
    paymentsPerYear,
    usedCompounding
  );
  return amortizingPayment(balance, periodicRate, amortYears * paymentsPerYear);
}
function calculateRenewalOffer(position, input) {
  const comparisonBalance = cleanNumber(position.renewalBalance) + cleanNumber(input.additionalBorrowing);
  const paymentsPerYear = paymentsPerYearForFrequency(input.paymentFrequency);
  const usedCompounding = compoundingUsed(input);
  const scheduledPayment = scheduledPaymentForOffer(position, input);
  const periodicRate = effectivePeriodicRate(
    cleanNumber(input.ratePercent),
    paymentsPerYear,
    usedCompounding
  );
  const termPeriods = Math.max(
    1,
    Math.round(cleanNumber(input.termYears) * paymentsPerYear)
  );
  let remainingBalance = comparisonBalance;
  let totalPayments = 0;
  let totalInterest = 0;
  let principalPaid = 0;
  let paymentCount = 0;
  for (let period = 0; period < termPeriods && remainingBalance > 5e-3; period += 1) {
    const interest = remainingBalance * periodicRate;
    const principal = Math.min(
      remainingBalance,
      Math.max(0, scheduledPayment - interest)
    );
    const actualPayment = principal + interest;
    remainingBalance = Math.max(0, remainingBalance - principal);
    totalPayments += actualPayment;
    totalInterest += interest;
    principalPaid += principal;
    paymentCount += 1;
  }
  const netSwitchingCost = cleanNumber(input.fees) + cleanNumber(input.penaltyCost) + cleanNumber(input.dischargeCost) + cleanNumber(input.registrationCost) + cleanNumber(input.transferAssignmentCost) + cleanNumber(input.legalCost) + cleanNumber(input.appraisalCost) + cleanNumber(input.adminCost) + cleanNumber(input.cashbackRepayment) + cleanNumber(input.otherCost) - cleanNumber(input.cashback);
  return {
    ...input,
    additionalBorrowing: roundCents(cleanNumber(input.additionalBorrowing)),
    newAmortizationYears: cleanNumber(input.newAmortizationYears),
    termYears: cleanNumber(input.termYears),
    ratePercent: cleanNumber(input.ratePercent),
    fees: roundCents(cleanNumber(input.fees)),
    cashback: roundCents(cleanNumber(input.cashback)),
    penaltyCost: roundCents(cleanNumber(input.penaltyCost)),
    dischargeCost: roundCents(cleanNumber(input.dischargeCost)),
    registrationCost: roundCents(cleanNumber(input.registrationCost)),
    transferAssignmentCost: roundCents(cleanNumber(input.transferAssignmentCost)),
    legalCost: roundCents(cleanNumber(input.legalCost)),
    appraisalCost: roundCents(cleanNumber(input.appraisalCost)),
    adminCost: roundCents(cleanNumber(input.adminCost)),
    cashbackRepayment: roundCents(cleanNumber(input.cashbackRepayment)),
    otherCost: roundCents(cleanNumber(input.otherCost)),
    comparisonBalance: roundCents(comparisonBalance),
    scheduledPayment: roundCents(scheduledPayment),
    paymentsPerYear,
    termPaymentCount: paymentCount,
    totalPaymentsDuringTerm: roundCents(totalPayments),
    totalInterestDuringTerm: roundCents(totalInterest),
    principalPaidDuringTerm: roundCents(principalPaid),
    endingBalance: roundCents(remainingBalance),
    netSwitchingCost: roundCents(netSwitchingCost),
    totalTermCost: roundCents(totalInterest + netSwitchingCost),
    compoundingUsed: usedCompounding,
    compoundingWasEstimated: input.compounding === "not_sure",
    isAdditionalBorrowing: comparisonBalance > cleanNumber(position.renewalBalance)
  };
}
function getRenewalComparisonIssues(position, offers) {
  const issues = [];
  if (cleanNumber(position.renewalBalance) <= 0) {
    issues.push({
      code: "invalid_balance",
      message: "Enter a renewal balance greater than $0 before ranking offers."
    });
  }
  if (cleanNumber(position.remainingAmortizationYears) <= 0) {
    issues.push({
      code: "invalid_position_amortization",
      message: "Enter a current remaining amortization greater than 0 years."
    });
  }
  offers.forEach((offer) => {
    if (cleanNumber(offer.newAmortizationYears) <= 0) {
      issues.push({
        code: "invalid_offer_amortization",
        message: `${offer.label || offer.id} needs a valid new amortization.`
      });
    }
    if (cleanNumber(offer.termYears) <= 0) {
      issues.push({
        code: "invalid_term",
        message: `${offer.label || offer.id} needs a term greater than 0 years.`
      });
    }
    if (!Number.isFinite(offer.ratePercent) || offer.ratePercent < 0) {
      issues.push({
        code: "invalid_rate",
        message: `${offer.label || offer.id} needs a valid rate.`
      });
    }
  });
  const terms = offers.map((offer) => cleanNumber(offer.termYears));
  if (terms.some((term) => term !== terms[0])) {
    issues.push({
      code: "unequal_terms",
      message: "These offers have different term lengths, so total term cost is not directly comparable. Compare payment, term interest and ending balance, or change them to matching terms."
    });
  }
  const balances = offers.map(
    (offer) => roundCents(
      cleanNumber(position.renewalBalance) + cleanNumber(offer.additionalBorrowing)
    )
  );
  if (balances.some((balance) => !sameMoney(balance, balances[0]))) {
    issues.push({
      code: "unequal_balances",
      message: "These offers use different comparison balances. This appears to include additional borrowing or refinancing and is not a straight renewal comparison."
    });
  }
  return issues;
}
function compareRenewalOffers(position, offers) {
  const results = offers.map((offer) => calculateRenewalOffer(position, offer));
  const issues = getRenewalComparisonIssues(position, offers);
  const comparable = issues.length === 0;
  const cheapest = comparable ? Math.min(...results.map((offer) => offer.totalTermCost)) : null;
  const cheapestOfferId = cheapest === null ? null : results.find((offer) => Math.abs(offer.totalTermCost - cheapest) < 5e-3)?.id ?? null;
  return {
    offers: results.map((offer) => ({
      ...offer,
      isLowestTotalCost: cheapest !== null && Math.abs(offer.totalTermCost - cheapest) < 5e-3,
      differenceVsCheapest: cheapest === null ? null : roundCents(offer.totalTermCost - cheapest)
    })),
    comparable,
    issues,
    cheapestOfferId
  };
}

// public/tax-data.json
var tax_data_default = {
  taxYear: 2026,
  CAN: {
    federal: {
      brackets: [
        { min: 0, max: 58523, base: 0, rate: 0.14 },
        { min: 58523, max: 117045, base: 8193.22, rate: 0.205 },
        { min: 117045, max: 181440, base: 20190.23, rate: 0.26 },
        { min: 181440, max: 258482, base: 36932.93, rate: 0.29 },
        { min: 258482, max: null, base: 59275.11, rate: 0.33 }
      ],
      cpp_rate: 0.0595,
      cpp_exemption: 3500,
      cpp_ympe: 74600,
      cpp_cap: 4230.45,
      cpp2_rate: 0.04,
      cpp2_ympe: 85e3,
      cpp2_cap: 416,
      qpp_rate: 0.063,
      qpp_cap: 4479.3,
      ei_rate: 0.0163,
      ei_cap: 1123.07,
      qc_ei_rate: 0.013,
      qc_ei_cap: 895.7,
      qpip_rate: 43e-4,
      qpip_cap: 442.9,
      rrsp_limit: 33810,
      qc_abatement_rate: 0.165,
      bpa: 16452,
      bpa_min: 14829,
      bpa_phaseout_start: 181440,
      bpa_phaseout_end: 258482
    },
    regions: [
      { id: "ON", label: "Ontario", bpa: 12989, surtax: [{ threshold: 5818, rate: 0.2 }, { threshold: 7446, rate: 0.36 }], health_premium: [{ min: 2e4, base: 0, rate: 0.06, cap: 300 }, { min: 36e3, base: 300, rate: 0.06, cap: 450 }, { min: 48e3, base: 450, rate: 0.25, cap: 600 }, { min: 72e3, base: 600, rate: 0.25, cap: 750 }, { min: 200600, base: 750, rate: 0.25, cap: 900 }], brackets: [{ min: 0, max: 53891, base: 0, rate: 0.0505 }, { min: 53891, max: 107785, base: 2721.5, rate: 0.0915 }, { min: 107785, max: 15e4, base: 7652.8, rate: 0.1116 }, { min: 15e4, max: 22e4, base: 12363.99, rate: 0.1216 }, { min: 22e4, max: null, base: 20875.99, rate: 0.1316 }] },
      { id: "BC", label: "British Columbia", bpa: 13216, brackets: [{ min: 0, max: 50363, base: 0, rate: 0.056 }, { min: 50363, max: 100728, base: 2820.33, rate: 0.077 }, { min: 100728, max: 115648, base: 6698.43, rate: 0.105 }, { min: 115648, max: 140430, base: 8265.03, rate: 0.1229 }, { min: 140430, max: 190405, base: 11310.74, rate: 0.147 }, { min: 190405, max: 265545, base: 18657.07, rate: 0.168 }, { min: 265545, max: null, base: 31280.59, rate: 0.205 }] },
      { id: "AB", label: "Alberta", bpa: 22769, brackets: [{ min: 0, max: 61200, base: 0, rate: 0.08 }, { min: 61200, max: 154259, base: 4896, rate: 0.1 }, { min: 154259, max: 185111, base: 14201.9, rate: 0.12 }, { min: 185111, max: 246813, base: 17904.14, rate: 0.13 }, { min: 246813, max: 370220, base: 25925.4, rate: 0.14 }, { min: 370220, max: null, base: 43202.38, rate: 0.15 }] },
      { id: "QC", label: "Quebec", bpa: 18952, brackets: [{ min: 0, max: 54345, base: 0, rate: 0.14 }, { min: 54345, max: 108680, base: 7608.3, rate: 0.19 }, { min: 108680, max: 132245, base: 17931.95, rate: 0.24 }, { min: 132245, max: null, base: 23587.55, rate: 0.2575 }] },
      { id: "SK", label: "Saskatchewan", bpa: 20381, brackets: [{ min: 0, max: 54532, base: 0, rate: 0.105 }, { min: 54532, max: 155805, base: 5725.86, rate: 0.125 }, { min: 155805, max: null, base: 18384.99, rate: 0.145 }] },
      { id: "MB", label: "Manitoba", bpa: 15780, brackets: [{ min: 0, max: 47e3, base: 0, rate: 0.108 }, { min: 47e3, max: 1e5, base: 5076, rate: 0.1275 }, { min: 1e5, max: null, base: 11833.5, rate: 0.174 }] },
      { id: "NS", label: "Nova Scotia", bpa: 11932, brackets: [{ min: 0, max: 30995, base: 0, rate: 0.0879 }, { min: 30995, max: 61991, base: 2724.46, rate: 0.1495 }, { min: 61991, max: 97417, base: 7358.36, rate: 0.1667 }, { min: 97417, max: 157124, base: 13263.88, rate: 0.175 }, { min: 157124, max: null, base: 23712.6, rate: 0.21 }] },
      { id: "NB", label: "New Brunswick", bpa: 13664, brackets: [{ min: 0, max: 52333, base: 0, rate: 0.094 }, { min: 52333, max: 104666, base: 4919.3, rate: 0.14 }, { min: 104666, max: 193861, base: 12245.92, rate: 0.16 }, { min: 193861, max: null, base: 26517.12, rate: 0.195 }] },
      { id: "PE", label: "Prince Edward Island", bpa: 15e3, brackets: [{ min: 0, max: 33928, base: 0, rate: 0.095 }, { min: 33928, max: 65820, base: 3223.16, rate: 0.1347 }, { min: 65820, max: 106890, base: 7519.01, rate: 0.166 }, { min: 106890, max: 142520, base: 14336.63, rate: 0.1762 }, { min: 142520, max: 2e5, base: 20614.64, rate: 0.19 }, { min: 2e5, max: null, base: 31535.84, rate: 0.2 }] },
      { id: "NL", label: "Newfoundland", bpa: 13094, brackets: [{ min: 0, max: 44678, base: 0, rate: 0.087 }, { min: 44678, max: 89354, base: 3886.99, rate: 0.145 }, { min: 89354, max: 159528, base: 10365.01, rate: 0.158 }, { min: 159528, max: 223340, base: 21452.5, rate: 0.178 }, { min: 223340, max: 285319, base: 32811.03, rate: 0.198 }, { min: 285319, max: 570638, base: 45082.88, rate: 0.208 }, { min: 570638, max: 1141275, base: 104429.23, rate: 0.213 }, { min: 1141275, max: null, base: 225974.91, rate: 0.218 }] },
      { id: "YT", label: "Yukon", bpa: 16452, brackets: [{ min: 0, max: 58523, base: 0, rate: 0.064 }, { min: 58523, max: 117045, base: 3745.47, rate: 0.09 }, { min: 117045, max: 181440, base: 9012.45, rate: 0.109 }, { min: 181440, max: 5e5, base: 16031.51, rate: 0.128 }, { min: 5e5, max: null, base: 56807.19, rate: 0.15 }] },
      { id: "NT", label: "Northwest Territories", bpa: 18198, brackets: [{ min: 0, max: 53003, base: 0, rate: 0.059 }, { min: 53003, max: 106009, base: 3127.18, rate: 0.086 }, { min: 106009, max: 172346, base: 7685.69, rate: 0.122 }, { min: 172346, max: null, base: 15778.81, rate: 0.1405 }] },
      { id: "NU", label: "Nunavut", bpa: 19659, brackets: [{ min: 0, max: 55801, base: 0, rate: 0.04 }, { min: 55801, max: 111602, base: 2232.04, rate: 0.07 }, { min: 111602, max: 181439, base: 6138.11, rate: 0.09 }, { min: 181439, max: null, base: 12423.44, rate: 0.115 }] }
    ]
  },
  USA: {
    federal: {
      brackets: {
        single: [
          { min: 0, max: 12400, base: 0, rate: 0.1 },
          { min: 12400, max: 50400, base: 1240, rate: 0.12 },
          { min: 50400, max: 105700, base: 5800, rate: 0.22 },
          { min: 105700, max: 201775, base: 17966, rate: 0.24 },
          { min: 201775, max: 256225, base: 41024, rate: 0.32 },
          { min: 256225, max: 640600, base: 58448, rate: 0.35 },
          { min: 640600, max: null, base: 192979.25, rate: 0.37 }
        ],
        married: [
          { min: 0, max: 24800, base: 0, rate: 0.1 },
          { min: 24800, max: 100800, base: 2480, rate: 0.12 },
          { min: 100800, max: 211400, base: 11600, rate: 0.22 },
          { min: 211400, max: 403550, base: 35932, rate: 0.24 },
          { min: 403550, max: 512450, base: 82048, rate: 0.32 },
          { min: 512450, max: 768700, base: 116896, rate: 0.35 },
          { min: 768700, max: null, base: 206583.5, rate: 0.37 }
        ],
        hoh: [
          { min: 0, max: 17700, base: 0, rate: 0.1 },
          { min: 17700, max: 67450, base: 1770, rate: 0.12 },
          { min: 67450, max: 105700, base: 7740, rate: 0.22 },
          { min: 105700, max: 201750, base: 16155, rate: 0.24 },
          { min: 201750, max: 256200, base: 39207, rate: 0.32 },
          { min: 256200, max: 640600, base: 56631, rate: 0.35 },
          { min: 640600, max: null, base: 191171, rate: 0.37 }
        ]
      },
      ss_rate: 0.062,
      ss_cap: 184500,
      medicare_rate: 0.0145,
      standard_deduction: { single: 16100, married: 32200, hoh: 24150 },
      "401k_limit": 24500,
      hsa_limit: 4400,
      hsa_family_limit: 8750
    },
    regions: [
      { id: "NY", label: "New York", rate: 0.065 },
      { id: "CA", label: "California", rate: 0.093 },
      { id: "TX", label: "Texas", rate: 0 },
      { id: "FL", label: "Florida", rate: 0 },
      { id: "IL", label: "Illinois", rate: 0.0495 },
      { id: "WA", label: "Washington", rate: 0 },
      { id: "MA", label: "Massachusetts", rate: 0.05 },
      { id: "CO", label: "Colorado", rate: 0.044 },
      { id: "OR", label: "Oregon", rate: 0.0875 },
      { id: "NV", label: "Nevada", rate: 0 }
    ]
  }
};

// lib/tax-figures.ts
var fed = tax_data_default.CAN.federal;
var TAX_YEAR = tax_data_default.taxYear;
var usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
var pct = (rate) => `${Math.round(rate * 1e4) / 100}%`;
var pct2 = (rate) => `${(Math.round(rate * 1e4) / 100).toFixed(2)}%`;
var brackets = fed.brackets.map((b) => ({
  from: b.min,
  to: b.max ?? null,
  rate: b.rate,
  base: b.base
}));
var round2 = (n) => Math.round(n * 100) / 100;
var regions = tax_data_default.CAN.regions.map((r) => ({
  id: r.id,
  label: r.label,
  lowRate: r.brackets[0].rate,
  topRate: r.brackets[r.brackets.length - 1].rate
}));
var lowestProvince = regions.reduce((a, b) => b.lowRate < a.lowRate ? b : a);
var highestProvince = regions.reduce((a, b) => b.topRate > a.topRate ? b : a);
var eiMaxInsurable = Math.round(fed.ei_cap / fed.ei_rate);
var TAX_FIGURES = {
  taxYear: TAX_YEAR,
  brackets,
  /** "$0 – $58,523", "$58,523 – $117,045", ..., "Over $258,482" */
  bracketRange: (i) => {
    const b = brackets[i];
    return b.to == null ? `Over ${usd(b.from)}` : `${usd(b.from)} \u2013 ${usd(b.to)}`;
  },
  bpa: fed.bpa,
  /** RRSP dollar limit for the tax year (CRA). */
  rrspLimit: fed.rrsp_limit,
  bpaCredit: round2(fed.bpa * brackets[0].rate),
  cpp: {
    exemption: fed.cpp_exemption,
    ympe: fed.cpp_ympe,
    yampe: fed.cpp2_ympe,
    rate: fed.cpp_rate,
    cap: fed.cpp_cap,
    cpp2Rate: fed.cpp2_rate,
    cpp2Cap: fed.cpp2_cap,
    basePensionable: fed.cpp_ympe - fed.cpp_exemption,
    /** Self-employed pay both halves. */
    selfEmployedRate: fed.cpp_rate * 2,
    selfEmployedCpp2Rate: fed.cpp2_rate * 2
  },
  ei: {
    rate: fed.ei_rate,
    cap: fed.ei_cap,
    maxInsurable: eiMaxInsurable,
    employerCap: round2(fed.ei_cap * 1.4),
    qcRate: fed.qc_ei_rate,
    qcCap: fed.qc_ei_cap,
    qcEmployerCap: round2(fed.qc_ei_cap * 1.4)
  },
  qpip: {
    rate: fed.qpip_rate,
    maxInsurable: Math.round(fed.qpip_cap / fed.qpip_rate)
  },
  provincial: {
    lowestRate: lowestProvince.lowRate,
    lowestLabel: lowestProvince.label,
    highestRate: highestProvince.topRate,
    highestLabel: highestProvince.label
  }
};

// lib/source-provenance.ts
var CANONICAL_PROVENANCE = {
  // --- Canadian Federal & Provincial Taxes ---
  "cra-federal-tax-brackets-2026": {
    ruleId: "cra-federal-tax-brackets-2026",
    label: "Federal Income Tax Brackets",
    statuteOrRegulation: "ITA s. 117(2)",
    authorityName: "Canada Revenue Agency",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/tax/individuals/tax-rates-brackets/current-year.html",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "2026 indexation factor 2.7%, 5 progressive federal tax brackets from 14% to 33%."
  },
  "cra-cpp-2026": {
    ruleId: "cra-cpp-2026",
    label: "CPP Contributions (Tier 1)",
    statuteOrRegulation: "Canada Pension Plan s. 11.1",
    authorityName: "Canada Revenue Agency",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/payroll-deductions-contributions/canada-pension-plan-cpp/cpp-contribution-rates-maximums-exemptions.html",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: `${pct(TAX_FIGURES.cpp.rate)} employee rate on pensionable earnings between ${usd(TAX_FIGURES.cpp.exemption)} exemption and ${usd(TAX_FIGURES.cpp.ympe)} YMPE.`
  },
  "cra-cpp2-2026": {
    ruleId: "cra-cpp2-2026",
    label: "CPP2 Contributions (Tier 2 Enhancement)",
    statuteOrRegulation: "Canada Pension Plan s. 11.2 (Bill C-26)",
    authorityName: "Canada Revenue Agency",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/payroll-deductions-contributions/canada-pension-plan-cpp/cpp-enhancement.html",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: `${pct2(TAX_FIGURES.cpp.cpp2Rate).replace(/0$/, "")} employee rate on earnings between ${usd(TAX_FIGURES.cpp.ympe)} YMPE and ${usd(TAX_FIGURES.cpp.yampe)} YAMPE.`
  },
  "cra-ei-2026": {
    ruleId: "cra-ei-2026",
    label: "Employment Insurance (EI) Premiums",
    statuteOrRegulation: "Employment Insurance Act s. 66",
    authorityName: "Canada Revenue Agency / ESDC",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/payroll-deductions-contributions/employment-insurance-ei/ei-premium-rates-maximums.html",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: `${pct(TAX_FIGURES.ei.rate)} employee premium up to maximum insurable earnings (MIE) of ${usd(TAX_FIGURES.ei.maxInsurable)}.`
  },
  "cra-bpa-2026": {
    ruleId: "cra-bpa-2026",
    label: "Basic Personal Amount (BPA)",
    statuteOrRegulation: "ITA s. 118(1)(a)",
    authorityName: "Canada Revenue Agency",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/tax/individuals/frequently-asked-questions-individuals/adjustment-personal-income-tax-benefit-amounts.html",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Federal BPA of $16,129 phased down to $14,546 for high-income earners; non-refundable credit at 14%."
  },
  "on-surtax-2026": {
    ruleId: "on-surtax-2026",
    label: "Ontario Surtax & Health Premium",
    statuteOrRegulation: "Income Tax Act (Ontario) s. 3 & s. 2.1",
    authorityName: "Ministry of Finance (Ontario)",
    sourceUrl: "https://www.ontario.ca/document/tax-rates-and-brackets",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "20% on ON tax exceeding $5,713 + 36% exceeding $7,310, plus progressive Ontario Health Premium tiers."
  },
  "rq-qpp-qpip-2026": {
    ruleId: "rq-qpp-qpip-2026",
    label: "Quebec QPP & QPIP Contributions",
    statuteOrRegulation: "Act respecting the Qu\xE9bec Pension Plan",
    authorityName: "Revenu Qu\xE9bec",
    sourceUrl: "https://www.revenuquebec.ca/en/businesses/source-deductions-and-employer-contributions/special-cases-source-deductions-and-employer-contributions-in-certain-situations/qpp-contributions/",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "6.40% employee QPP rate plus QPIP maternity/paternity insurance deductions."
  },
  // --- Mortgage & Real Estate ---
  "interest-act-s6-compounding": {
    ruleId: "interest-act-s6-compounding",
    label: "Canadian Semi-Annual Mortgage Compounding",
    statuteOrRegulation: "Interest Act (Canada) R.S.C. 1985 c. I-15 s. 6",
    authorityName: "Government of Canada (Legislation)",
    sourceUrl: "https://laws-lois.justice.gc.ca/eng/acts/I-15/section-6.html",
    effectiveDate: "1985-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Canadian fixed mortgages compound semi-annually, not in advance. Effective monthly rate = (1 + r/200)^(2/12) - 1."
  },
  "osfi-b20-stress-test": {
    ruleId: "osfi-b20-stress-test",
    label: "OSFI Minimum Qualifying Rate (B-20 Stress Test)",
    statuteOrRegulation: "OSFI Guideline B-20 (Residential Mortgage Underwriting)",
    authorityName: "Office of the Superintendent of Financial Institutions (OSFI)",
    sourceUrl: "https://www.osfi-bsif.gc.ca/en/supervision/financial-institutions/banks/minimum-qualifying-rate-uninsured-mortgages",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Borrowers qualify at the greater of contract rate + 2.00% or 5.25% floor."
  },
  "cmhc-loan-insurance": {
    ruleId: "cmhc-loan-insurance",
    label: "CMHC Mortgage Loan Insurance Premium",
    statuteOrRegulation: "National Housing Act / CMHC Premium Schedule",
    authorityName: "Canada Mortgage and Housing Corporation (CMHC)",
    sourceUrl: "https://www.cmhc-schl.gc.ca/consumers/home-buying/calculators",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Mandatory default insurance for LTV > 80%: 2.80% (15-19.99% down), 3.10% (10-14.99% down), 4.00% (5-9.99% down)."
  },
  "cmhc-gds-tds-limits": {
    ruleId: "cmhc-gds-tds-limits",
    label: "CMHC Debt Service Ratio Maximums (GDS/TDS)",
    statuteOrRegulation: "CMHC Mortgage Underwriting Standards",
    authorityName: "Canada Mortgage and Housing Corporation (CMHC)",
    sourceUrl: "https://www.cmhc-schl.gc.ca/professionals/project-funding-and-mortgage-financing/mortgage-loan-insurance/calculating-gds-tds",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Maximum 39% GDS and 44% TDS for insured mortgages with credit scores >= 680; 50% condo fees included in GDS."
  },
  // --- Sales Tax (GST / HST / PST / QST) ---
  "cra-gst-5": {
    ruleId: "cra-gst-5",
    label: "Federal Goods and Services Tax (GST 5%)",
    statuteOrRegulation: "Excise Tax Act R.S.C. 1985 c. E-15 s. 165(1)",
    authorityName: "Canada Revenue Agency",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html",
    effectiveDate: "2008-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "5% federal tax on taxable supplies of goods and services made in Canada."
  },
  "on-hst-13": {
    ruleId: "on-hst-13",
    label: "Ontario Harmonized Sales Tax (HST 13%)",
    statuteOrRegulation: "Comprehensive Integrated Tax Coordination Agreement (CITCA)",
    authorityName: "CRA / Ontario Ministry of Finance",
    sourceUrl: "https://www.ontario.ca/document/harmonized-sales-tax-hst",
    effectiveDate: "2010-07-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "13% combined rate (5% federal + 8% provincial) administered by the CRA."
  },
  "ns-hst-14": {
    ruleId: "ns-hst-14",
    label: "Nova Scotia Harmonized Sales Tax (HST 14%)",
    statuteOrRegulation: "Nova Scotia Provincial Sales Tax Act (1% rate reduction)",
    authorityName: "Nova Scotia Department of Finance",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html",
    effectiveDate: "2025-04-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "14% combined rate (5% federal + 9% provincial) effective April 1, 2025."
  },
  "bc-pst-7": {
    ruleId: "bc-pst-7",
    label: "BC Provincial Sales Tax (PST 7%)",
    statuteOrRegulation: "Provincial Sales Tax Act [SBC 2012] c. 35 s. 34",
    authorityName: "BC Ministry of Finance",
    sourceUrl: "https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst",
    effectiveDate: "2013-04-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "7% provincial retail sales tax applied alongside 5% federal GST."
  },
  "rq-qst-9975": {
    ruleId: "rq-qst-9975",
    label: "Quebec Sales Tax (QST 9.975%)",
    statuteOrRegulation: "Act respecting the Qu\xE9bec sales tax (CQLR c. T-0.1)",
    authorityName: "Revenu Qu\xE9bec",
    sourceUrl: "https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/basic-rules-for-applying-the-gsthst-and-qst/",
    effectiveDate: "2013-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "9.975% provincial value-added tax calculated on the pre-GST selling price."
  },
  // --- Benefits & Family Support ---
  "cra-ccb-2026": {
    ruleId: "cra-ccb-2026",
    label: "Canada Child Benefit (CCB)",
    statuteOrRegulation: "Income Tax Act s. 122.61",
    authorityName: "Canada Revenue Agency",
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/child-family-benefits/canada-child-benefit-overview.html",
    effectiveDate: "2025-07-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Indexed non-taxable monthly payment for eligible families supporting children under 18."
  },
  // --- Landlord & Tenant Legal Rules ---
  "ontario-rta-n12-notice": {
    ruleId: "ontario-rta-n12-notice",
    label: "Ontario N12 Minimum 60 Days Notice",
    statuteOrRegulation: "Residential Tenancies Act, 2006, S.O. 2006, c. 17, s. 48(2)",
    authorityName: "Landlord and Tenant Board (Ontario)",
    sourceUrl: "https://www.ontario.ca/laws/statute/06r17#BK56",
    effectiveDate: "2007-01-31",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Notice date must be at least 60 days after given and must align with the last day of a tenancy period."
  },
  "ontario-rta-n12-compensation": {
    ruleId: "ontario-rta-n12-compensation",
    label: "Ontario N12 One Month Rent Compensation",
    statuteOrRegulation: "Residential Tenancies Act, 2006, S.O. 2006, c. 17, s. 48.1 & s. 55.1",
    authorityName: "Landlord and Tenant Board (Ontario)",
    sourceUrl: "https://www.ontario.ca/laws/statute/06r17#BK57",
    effectiveDate: "2017-09-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Landlord must pay 1 month compensation or offer another acceptable unit on or before the termination date."
  },
  "ontario-rta-l2-deadline": {
    ruleId: "ontario-rta-l2-deadline",
    label: "Ontario L2 Application 30-Day Filing Deadline",
    statuteOrRegulation: "Residential Tenancies Act, 2006, S.O. 2006, c. 17, s. 69(2)",
    authorityName: "Landlord and Tenant Board (Ontario)",
    sourceUrl: "https://www.ontario.ca/laws/statute/06r17#BK82",
    effectiveDate: "2007-01-31",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "L2 application to evict must be filed no later than 30 days after the termination date set out in the N12 notice."
  },
  "ontario-rta-n4-notice": {
    ruleId: "ontario-rta-n4-notice",
    label: "Ontario N4 Non-Payment of Rent 14-Day Notice",
    statuteOrRegulation: "Residential Tenancies Act, 2006, s. 59(1) & LTB Rule 3",
    authorityName: "Landlord and Tenant Board (Ontario)",
    sourceUrl: "https://www.ontario.ca/laws/statute/06r17#BK70",
    effectiveDate: "2007-01-31",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Minimum 14 calendar days for monthly tenancy plus statutory mailing/courier delivery buffer."
  },
  "ontario-ltb-review-rule26": {
    ruleId: "ontario-ltb-review-rule26",
    label: "Ontario LTB Request for Review 30-Day Deadline",
    statuteOrRegulation: "LTB Rules of Practice Rule 26.2",
    authorityName: "Tribunals Ontario (LTB)",
    sourceUrl: "https://tribunalsontario.ca/ltb/rules-practice-directives/",
    effectiveDate: "2021-12-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Request to review an LTB order must be made within 30 days of the date of the order."
  },
  "bc-court-order-interest": {
    ruleId: "bc-court-order-interest",
    label: "BC Court Order Post-Judgment Interest Rates",
    statuteOrRegulation: "Court Order Interest Act [RSBC 1996] c. 79 s. 7",
    authorityName: "BC Ministry of Attorney General",
    sourceUrl: "https://www2.gov.bc.ca/gov/content/justice/courthouse-services/documents-forms-records/court-order-interest-rates",
    effectiveDate: "2026-01-01",
    lastVerifiedDate: "2026-08-01",
    ruleSnippet: "Prescribed prime lending rates set semi-annually on January 1 and July 1 each year."
  }
};

// app/pay/engine/tax.ts
var toAnnual = (amt, p) => {
  if (p === "monthly") return amt * 12;
  if (p === "semi-monthly") return amt * 24;
  if (p === "biweekly") return amt * 26;
  if (p === "weekly") return amt * 52;
  return amt;
};
var calcBracket = (amt, brackets2) => {
  if (!brackets2) return 0;
  for (let i = brackets2.length - 1; i >= 0; i--) {
    if (amt > brackets2[i].min) {
      return brackets2[i].base + (amt - brackets2[i].min) * brackets2[i].rate;
    }
  }
  return 0;
};
var applyBpaCredit = (grossTax, bpa, brackets2) => {
  if (!bpa || !brackets2?.length) return grossTax;
  const lowestRate = brackets2[0].rate;
  return Math.max(0, grossTax - bpa * lowestRate);
};
var federalBpaFor = (income, fed2) => {
  const max = fed2?.bpa;
  if (!max) return void 0;
  const min = fed2.bpa_min ?? max;
  const start = fed2.bpa_phaseout_start;
  const end = fed2.bpa_phaseout_end;
  if (!start || !end || end <= start || income <= start) return max;
  if (income >= end) return min;
  return max - (max - min) * ((income - start) / (end - start));
};
var applySurtax = (provincialTax, surtax) => {
  if (!surtax?.length) return provincialTax;
  const extra = surtax.reduce(
    (sum, tier) => sum + Math.max(0, provincialTax - tier.threshold) * tier.rate,
    0
  );
  return provincialTax + extra;
};
var healthPremium = (income, tiers) => {
  if (!tiers?.length) return 0;
  let premium = 0;
  for (const tier of tiers) {
    if (income > tier.min) {
      premium = Math.min(tier.cap, tier.base + (income - tier.min) * tier.rate);
    }
  }
  return premium;
};
function calculateNet(amount, country, region, period, taxData, options = {}) {
  if (!amount || !taxData) return null;
  const { filingStatus = "single", retirement401k = 0, retirementRRSP = 0, hsa = 0 } = options;
  const annualGross = toAnnual(amount, period);
  const fed2 = country === "USA" ? taxData.USA?.federal : taxData.CAN?.federal;
  if (!fed2) return null;
  let taxableIncome = annualGross;
  if (country === "USA") {
    const usaFed = fed2;
    taxableIncome -= Math.min(retirement401k, usaFed["401k_limit"] || 23500);
    taxableIncome -= Math.min(hsa, annualGross >= 5e4 ? usaFed["hsa_family_limit"] || 8300 : usaFed["hsa_limit"] || 4150);
    taxableIncome -= usaFed["standard_deduction"]?.[filingStatus] || 15e3;
  } else {
    const canFed = fed2;
    const rrspLimit = Number.isFinite(canFed["rrsp_limit"]) ? canFed["rrsp_limit"] : Number.POSITIVE_INFINITY;
    taxableIncome -= Math.min(retirementRRSP, rrspLimit);
  }
  let regionalTax = 0;
  let canRegion;
  if (country === "USA" && taxData.USA?.regions) {
    const regData = taxData.USA.regions.find((r) => r.id === region);
    if (regData) {
      regionalTax = regData.brackets ? calcBracket(annualGross, regData.brackets) : annualGross * (regData.rate || 0);
    }
  } else if (country === "CAN" && taxData.CAN?.regions) {
    const regData = taxData.CAN.regions.find((r) => r.id === region);
    if (regData) {
      canRegion = regData;
      regionalTax = regData.brackets ? calcBracket(taxableIncome, regData.brackets) : taxableIncome * (regData.rate || 0);
    }
  }
  let federalTax = 0;
  if (country === "USA") {
    const usaFed = fed2;
    const brackets2 = usaFed.brackets?.[filingStatus] || usaFed.brackets?.["single"];
    federalTax = calcBracket(taxableIncome, brackets2);
  } else {
    const canFed = fed2;
    federalTax = applyBpaCredit(
      calcBracket(taxableIncome, canFed.brackets),
      federalBpaFor(taxableIncome, canFed),
      canFed.brackets
    );
    if (region === "QC") {
      federalTax *= 1 - (canFed.qc_abatement_rate ?? 0.165);
    }
    let provBaseTax = applyBpaCredit(regionalTax, canRegion?.bpa, canRegion?.brackets);
    const surtaxAmount = applySurtax(provBaseTax, canRegion?.surtax) - provBaseTax;
    const healthPremAmount = healthPremium(taxableIncome, canRegion?.health_premium);
    regionalTax = provBaseTax + surtaxAmount + healthPremAmount;
  }
  let otherTax = 0;
  let cpp = 0;
  let cpp2 = 0;
  let ei = 0;
  let qpp = 0;
  let qpp2 = 0;
  let qpip = 0;
  if (country === "USA") {
    const usaFed = fed2;
    otherTax = Math.min(annualGross, usaFed.ss_cap) * usaFed.ss_rate + annualGross * usaFed.medicare_rate;
    if (annualGross > 2e5) otherTax += (annualGross - 2e5) * 9e-3;
  } else {
    const canFed = fed2;
    const pensionExemption = canFed.cpp_exemption || 3500;
    const ympe = canFed.cpp_ympe || 74600;
    const yampe = canFed.cpp2_ympe || 85e3;
    const firstTierEarnings = Math.max(0, Math.min(annualGross, ympe) - pensionExemption);
    const secondTierEarnings = Math.max(0, Math.min(annualGross, yampe) - ympe);
    if (region === "QC") {
      qpp = Math.min(firstTierEarnings * (canFed.qpp_rate || 0.063), canFed.qpp_cap || Number.POSITIVE_INFINITY);
      qpp2 = Math.min(secondTierEarnings * (canFed.cpp2_rate || 0.04), canFed.cpp2_cap || Number.POSITIVE_INFINITY);
      ei = Math.min(annualGross * (canFed.qc_ei_rate || 0.013), canFed.qc_ei_cap || Number.POSITIVE_INFINITY);
      qpip = Math.min(annualGross * (canFed.qpip_rate || 43e-4), canFed.qpip_cap || Number.POSITIVE_INFINITY);
      otherTax = qpp + qpp2 + ei + qpip;
    } else {
      cpp = Math.min(firstTierEarnings * canFed.cpp_rate, canFed.cpp_cap);
      cpp2 = Math.min(secondTierEarnings * (canFed.cpp2_rate || 0.04), canFed.cpp2_cap || Number.POSITIVE_INFINITY);
      ei = Math.min(annualGross * canFed.ei_rate, canFed.ei_cap);
      otherTax = cpp + cpp2 + ei;
    }
  }
  const totalTax = federalTax + regionalTax + otherTax;
  const annualNet = annualGross - totalTax - retirement401k - retirementRRSP - hsa;
  const ruleLineage = {};
  if (country === "CAN") {
    if (federalTax > 0) ruleLineage["fed-tax"] = CANONICAL_PROVENANCE["cra-federal-tax-brackets-2026"];
    if (cpp > 0) ruleLineage["cpp"] = CANONICAL_PROVENANCE["cra-cpp-2026"];
    if (cpp2 > 0) ruleLineage["cpp2"] = CANONICAL_PROVENANCE["cra-cpp2-2026"];
    if (ei > 0) ruleLineage["ei"] = CANONICAL_PROVENANCE["cra-ei-2026"];
    if (region === "ON") ruleLineage["on-surtax"] = CANONICAL_PROVENANCE["on-surtax-2026"];
    if (region === "QC") ruleLineage["qc-qpp"] = CANONICAL_PROVENANCE["rq-qpp-qpip-2026"];
  }
  return {
    annualGross,
    annualGrossAfter401k: annualGross - retirement401k - retirementRRSP - hsa,
    annualNet,
    federalTax,
    regionalTax,
    otherTax,
    totalTax,
    retirement401k,
    retirementRRSP,
    hsa,
    keepPercentage: annualNet / annualGross * 100,
    cpp,
    cpp2,
    ei,
    qpp,
    qpp2,
    qpip,
    ruleLineage
  };
}

// lib/province-data.ts
var PROVINCES = [
  { id: "ON", label: "Ontario", hst: 0.13, gst: 0, pst: 0 },
  { id: "BC", label: "British Columbia", hst: 0, gst: 0.05, pst: 0.07 },
  { id: "AB", label: "Alberta", hst: 0, gst: 0.05, pst: 0 },
  { id: "QC", label: "Quebec", hst: 0, gst: 0.05, pst: 0.09975 },
  { id: "NS", label: "Nova Scotia", hst: 0.14, gst: 0, pst: 0 },
  { id: "NB", label: "New Brunswick", hst: 0.15, gst: 0, pst: 0 },
  { id: "MB", label: "Manitoba", hst: 0, gst: 0.05, pst: 0.07 },
  { id: "SK", label: "Saskatchewan", hst: 0, gst: 0.05, pst: 0.06 },
  { id: "PE", label: "PEI", hst: 0.15, gst: 0, pst: 0 },
  { id: "NL", label: "Newfoundland", hst: 0.15, gst: 0, pst: 0 },
  { id: "YT", label: "Yukon", hst: 0, gst: 0.05, pst: 0 },
  { id: "NT", label: "Northwest Territories", hst: 0, gst: 0.05, pst: 0 },
  { id: "NU", label: "Nunavut", hst: 0, gst: 0.05, pst: 0 }
];

// app/gst/engine.ts
function calculateGst(amount, provinceId, includeInTotal) {
  const prov = PROVINCES.find((p) => p.id === provinceId) || PROVINCES[0];
  const combinedRate = prov.gst + prov.pst + prov.hst;
  const preTaxAmount = includeInTotal && combinedRate > 0 ? amount / (1 + combinedRate) : amount;
  const gstAmount = preTaxAmount * prov.gst;
  const pstAmount = preTaxAmount * prov.pst;
  const hstAmount = preTaxAmount * prov.hst;
  const totalTax = gstAmount + pstAmount + hstAmount;
  return {
    base: preTaxAmount,
    gst: gstAmount,
    pst: pstAmount,
    hst: hstAmount,
    totalTax,
    finalAmount: preTaxAmount + totalTax,
    rate: combinedRate
  };
}

// app/auto-loan-calculator-canada/engine.ts
var round = (value) => Math.round(value * 100) / 100;
function calculateAutoLoan(input) {
  const termMonths = Math.max(1, Math.round(input.termMonths));
  const monthlyRate = Math.max(0, input.annualRatePercent) / 100 / 12;
  const netTradeInEquity = input.tradeInValue - input.amountOwingOnTrade;
  const taxableAmount = Math.max(0, input.vehiclePrice - Math.max(0, input.tradeInValue));
  const salesTax = taxableAmount * (Math.max(0, input.taxRatePercent) / 100);
  const totalBeforeDownPayment = input.vehiclePrice + salesTax + input.fees + input.amountOwingOnTrade - input.tradeInValue - input.rebate;
  const amountFinanced = Math.max(0, totalBeforeDownPayment - input.downPayment);
  const monthlyPayment = amountFinanced <= 0 ? 0 : monthlyRate === 0 ? amountFinanced / termMonths : amountFinanced * monthlyRate / (1 - Math.pow(1 + monthlyRate, -termMonths));
  let balance = amountFinanced;
  let interestPaid = 0;
  let principalPaid = 0;
  const schedule = [];
  const requestedMonths = [12, 24, 36, 48, 60, termMonths].filter((month) => month <= termMonths).filter((month, index, months) => months.indexOf(month) === index);
  for (let month = 1; month <= termMonths; month += 1) {
    const interest = balance * monthlyRate;
    const principal = Math.min(balance, monthlyPayment - interest);
    interestPaid += interest;
    principalPaid += principal;
    balance = Math.max(0, balance - principal);
    if (requestedMonths.includes(month)) {
      schedule.push({
        month,
        principalPaid: round(principalPaid),
        interestPaid: round(interestPaid),
        balance: round(balance)
      });
    }
  }
  const totalPayments = monthlyPayment * termMonths;
  return {
    taxableAmount: round(taxableAmount),
    netTradeInEquity: round(netTradeInEquity),
    salesTax: round(salesTax),
    totalBeforeDownPayment: round(totalBeforeDownPayment),
    amountFinanced: round(amountFinanced),
    monthlyPayment: round(monthlyPayment),
    totalPayments: round(totalPayments),
    totalInterest: round(totalPayments - amountFinanced),
    totalCostBeforeResale: round(input.downPayment + totalPayments),
    balanceSchedule: schedule
  };
}

// docs/distribution/iso-3779-vin-validator/index.ts
var VALID_CHARS = new Set("0123456789ABCDEFGHJKLMNPRSTUVWXYZ");
var VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
var CHAR_VALUES = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9
};
function decodeModelYear(char) {
  const c = char.toUpperCase();
  const cycle1 = {
    A: 1980,
    B: 1981,
    C: 1982,
    D: 1983,
    E: 1984,
    F: 1985,
    G: 1986,
    H: 1987,
    J: 1988,
    K: 1989,
    L: 1990,
    M: 1991,
    N: 1992,
    P: 1993,
    R: 1994,
    S: 1995,
    T: 1996,
    V: 1997,
    W: 1998,
    X: 1999,
    Y: 2e3
  };
  const cycle2 = {
    "1": 2001,
    "2": 2002,
    "3": 2003,
    "4": 2004,
    "5": 2005,
    "6": 2006,
    "7": 2007,
    "8": 2008,
    "9": 2009
  };
  const cycle3 = {
    A: 2010,
    B: 2011,
    C: 2012,
    D: 2013,
    E: 2014,
    F: 2015,
    G: 2016,
    H: 2017,
    J: 2018,
    K: 2019,
    L: 2020,
    M: 2021,
    N: 2022,
    P: 2023,
    R: 2024,
    S: 2025,
    T: 2026,
    V: 2027,
    W: 2028,
    X: 2029,
    Y: 2030
  };
  return cycle3[c] ?? cycle2[c] ?? cycle1[c] ?? null;
}
function calculateCheckDigit(vin) {
  if (vin.length !== 17) return null;
  const cleanVin = vin.toUpperCase();
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue;
    const val = CHAR_VALUES[cleanVin[i]];
    if (val === void 0) return null;
    sum += val * VIN_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}
function validateVin(vin) {
  const clean = vin.trim().toUpperCase();
  if (clean.length !== 17) {
    return { valid: false, error: "VIN must be exactly 17 characters" };
  }
  for (const ch of clean) {
    if (!VALID_CHARS.has(ch)) {
      return {
        valid: false,
        error: `Invalid character "${ch}". VIN uses 0-9, A-Z (excluding I, O, Q)`
      };
    }
  }
  const expectedCheckChar = calculateCheckDigit(clean);
  const actualCheckChar = clean[8];
  if (expectedCheckChar !== actualCheckChar) {
    return {
      valid: false,
      error: `Check digit mismatch at position 9: expected "${expectedCheckChar}", got "${actualCheckChar}"`
    };
  }
  return {
    valid: true,
    wmi: clean.slice(0, 3),
    vds: clean.slice(3, 8),
    checkDigit: actualCheckChar,
    modelYearChar: clean[9],
    modelYear: decodeModelYear(clean[9]),
    plantCode: clean[10],
    sequentialNumber: clean.slice(11, 17)
  };
}

// packages/mcp-server/src/tools.ts
var PROVINCE_IDS = [
  "ON",
  "BC",
  "AB",
  "QC",
  "SK",
  "MB",
  "NS",
  "NB",
  "PE",
  "NL",
  "YT",
  "NT",
  "NU"
];
var MORTGAGE_FREQUENCIES = [
  "monthly",
  "biweekly",
  "weekly",
  "biweekly_acc",
  "weekly_acc"
];
var RENEWAL_FREQUENCIES = [
  "monthly",
  "biweekly",
  "weekly",
  "accelerated_biweekly",
  "accelerated_weekly"
];
var PAY_PERIODS = [
  "annual",
  "monthly",
  "semi-monthly",
  "biweekly",
  "weekly"
];
function jsonResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}
function runCanadianMortgage(input) {
  const result = calculateMortgage(input);
  const stressRate = Math.max(input.rate + 2, 5.25);
  const stressResult = calculateMortgage(input, stressRate);
  return {
    payment: Math.round(result.payment * 100) / 100,
    loanAmount: Math.round(result.loan * 100) / 100,
    cmhcInsurance: Math.round(result.cmhc * 100) / 100,
    downPaymentPercent: Math.round(result.dpPct * 100) / 100,
    totalInterest: Math.round(result.interest * 100) / 100,
    totalCost: Math.round(result.total * 100) / 100,
    landTransferTax: Math.round(result.landTransferTax * 100) / 100,
    stressTestRate: stressRate,
    stressTestPayment: Math.round(stressResult.payment * 100) / 100,
    compounding: "semi-annual (Canadian Interest Act)",
    sourceUrl: "https://usecos.app/mortgage"
  };
}
function runCanadianPaycheck(input) {
  const result = calculateNet(
    input.amount,
    "CAN",
    input.province,
    input.period,
    tax_data_default,
    { retirementRRSP: input.retirementRRSP ?? 0 }
  );
  if (!result) {
    throw new Error("Unable to calculate paycheck for the provided inputs.");
  }
  return {
    taxYear: tax_data_default.taxYear,
    province: input.province,
    period: input.period,
    annualGross: result.annualGross,
    annualNet: result.annualNet,
    federalTax: result.federalTax,
    provincialTax: result.regionalTax,
    payrollContributions: result.otherTax,
    totalTax: result.totalTax,
    keepPercentage: result.keepPercentage,
    cpp: result.cpp ?? 0,
    cpp2: result.cpp2 ?? 0,
    ei: result.ei ?? 0,
    qpp: result.qpp ?? 0,
    qpp2: result.qpp2 ?? 0,
    qpip: result.qpip ?? 0,
    surtax: result.surtax ?? 0,
    healthPremium: result.healthPremium ?? 0,
    sourceUrl: "https://usecos.app/pay",
    methodologyUrl: "https://usecos.app/methodology/paycheck-calculator-validation"
  };
}
function runCanadianGstHst(input) {
  const result = calculateGst(input.amount, input.province, input.includeInTotal);
  const provMeta = PROVINCES.find((p) => p.id === input.province);
  return {
    province: input.province,
    provinceName: provMeta?.label ?? input.province,
    includeInTotal: input.includeInTotal,
    preTaxAmount: result.base,
    gst: result.gst,
    pst: result.pst,
    hst: result.hst,
    totalTax: result.totalTax,
    finalAmount: result.finalAmount,
    combinedRatePercent: Math.round(result.rate * 1e4) / 100,
    sourceUrl: "https://usecos.app/gst"
  };
}
function runCanadianAutoLoan(input) {
  const result = calculateAutoLoan(input);
  return {
    taxableAmount: result.taxableAmount,
    netTradeInEquity: result.netTradeInEquity,
    salesTax: result.salesTax,
    amountFinanced: result.amountFinanced,
    monthlyPayment: result.monthlyPayment,
    totalPayments: result.totalPayments,
    totalInterest: result.totalInterest,
    totalCostBeforeResale: result.totalCostBeforeResale,
    sourceUrl: "https://usecos.app/auto-loan-calculator-canada"
  };
}
function runValidateIsoVin(vin) {
  const result = validateVin(vin);
  return {
    ...result,
    standard: "ISO 3779 / US 49 CFR Part 565",
    sourceUrl: "https://usecos.app/vin"
  };
}
function registerUsecosTools(server2) {
  server2.tool(
    "calculate_canadian_mortgage",
    "Calculate Canadian mortgage payment (semi-annual compounding), CMHC insurance, provincial land transfer tax, and OSFI B-20 stress-test payment.",
    {
      mode: z.enum(["purchase", "refinance"]).default("purchase"),
      price: z.number().positive().describe("Home purchase price or mortgage balance in CAD"),
      downPayment: z.number().min(0).default(0).describe("Down payment in CAD"),
      rate: z.number().min(0).max(30).describe("Nominal annual interest rate in percent (e.g. 4.79)"),
      amort: z.number().min(1).max(35).default(25).describe("Amortization period in years"),
      frequency: z.enum(MORTGAGE_FREQUENCIES).default("monthly"),
      province: z.enum(PROVINCE_IDS).default("ON"),
      extraPayment: z.number().min(0).default(0),
      lumpSumAmount: z.number().min(0).default(0),
      lumpSumYear: z.number().int().min(1).default(1)
    },
    async (args) => jsonResult(runCanadianMortgage(args))
  );
  server2.tool(
    "compare_mortgage_renewals",
    "Deterministically compare 2 or 3 Canadian mortgage renewal offers by scheduled payment, term interest, principal paid, ending balance, switching costs, and total term cost.",
    {
      position: z.object({
        renewalBalance: z.number().positive(),
        remainingAmortizationYears: z.number().positive(),
        renewalDate: z.string().default("not_provided"),
        currentPayment: z.number().min(0).default(0),
        currentPaymentFrequency: z.enum(RENEWAL_FREQUENCIES).default("monthly"),
        renewalTiming: z.enum(["maturity", "early"]).default("maturity")
      }),
      offers: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          additionalBorrowing: z.number().min(0).default(0),
          newAmortizationYears: z.number().positive(),
          termYears: z.number().positive(),
          ratePercent: z.number().min(0).max(30),
          rateType: z.enum(["fixed", "variable"]).default("fixed"),
          paymentFrequency: z.enum(RENEWAL_FREQUENCIES).default("monthly"),
          compounding: z.enum(["semi_annual", "monthly", "not_sure"]).default("semi_annual"),
          fees: z.number().min(0).default(0),
          cashback: z.number().min(0).default(0),
          penaltyCost: z.number().min(0).default(0),
          dischargeCost: z.number().min(0).default(0),
          registrationCost: z.number().min(0).default(0),
          transferAssignmentCost: z.number().min(0).default(0),
          legalCost: z.number().min(0).default(0),
          appraisalCost: z.number().min(0).default(0),
          adminCost: z.number().min(0).default(0),
          cashbackRepayment: z.number().min(0).default(0),
          otherCost: z.number().min(0).default(0)
        })
      ).min(2).max(3)
    },
    async (args) => {
      const comparison = compareRenewalOffers(args.position, args.offers);
      return jsonResult({
        ...comparison,
        sourceUrl: "https://usecos.app/mortgage/renewal-offer-analyzer",
        methodologyUrl: "https://usecos.app/methodology/mortgage-renewal-validation"
      });
    }
  );
  server2.tool(
    "calculate_canadian_paycheck",
    "Calculate Canadian take-home pay, federal/provincial income tax, CPP/CPP2, EI/QPIP, and Ontario surtax across all 13 provinces and territories.",
    {
      amount: z.number().positive().describe("Gross employment income for the selected period in CAD"),
      province: z.enum(PROVINCE_IDS).default("ON"),
      period: z.enum(PAY_PERIODS).default("annual"),
      retirementRRSP: z.number().min(0).default(0).describe("Annual RRSP deduction in CAD")
    },
    async (args) => jsonResult(runCanadianPaycheck(args))
  );
  server2.tool(
    "calculate_canadian_gst_hst",
    "Calculate or reverse-extract Canadian GST, PST, and HST for any province or territory.",
    {
      amount: z.number().min(0).describe("Pre-tax subtotal (if includeInTotal=false) or tax-included receipt total (if includeInTotal=true)"),
      province: z.enum(PROVINCE_IDS).default("ON"),
      includeInTotal: z.boolean().default(false)
    },
    async (args) => jsonResult(runCanadianGstHst(args))
  );
  server2.tool(
    "calculate_canadian_auto_loan",
    "Calculate Canadian auto loan monthly payment, provincial sales tax after trade-in, net trade-in equity, and total interest.",
    {
      vehiclePrice: z.number().positive(),
      downPayment: z.number().min(0).default(0),
      tradeInValue: z.number().min(0).default(0),
      amountOwingOnTrade: z.number().min(0).default(0),
      taxRatePercent: z.number().min(0).max(25).default(13),
      fees: z.number().min(0).default(0),
      rebate: z.number().min(0).default(0),
      annualRatePercent: z.number().min(0).max(40),
      termMonths: z.number().int().min(1).max(120).default(60)
    },
    async (args) => jsonResult(runCanadianAutoLoan(args))
  );
  server2.tool(
    "validate_iso_vin",
    "Validate a 17-character Vehicle Identification Number (VIN) under ISO 3779 and US 49 CFR Part 565, verifying the Position 9 check digit and decoding WMI, model year, and plant code.",
    {
      vin: z.string().min(1).describe("17-character VIN to validate and decode")
    },
    async (args) => jsonResult(runValidateIsoVin(args.vin))
  );
}

// packages/mcp-server/src/index.ts
var server = new McpServer({
  name: "usecos-mcp",
  version: "1.0.0"
});
registerUsecosTools(server);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((error) => {
  console.error("usecos-mcp fatal error:", error);
  process.exit(1);
});
