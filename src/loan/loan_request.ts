import { BaseLoan, BaseLoanConstructorParams } from "./base_loan";

import { BigNumber } from "../../utils/bignumber";
import { BLOCK_TIME_ESTIMATE_SECONDS, NULL_ECDSA_SIGNATURE } from "../../utils/constants";

import { CollateralizedSimpleInterestLoanOrder } from "../adapters/collateralized_simple_interest_loan_adapter";

import { Dharma } from "../dharma";

import {
    DebtOrderData,
    DurationUnit,
    EthereumAddress,
    InterestRate,
    Loan,
    TimeInterval,
    TokenAmount,
} from "../types";

export interface LoanRequestParams {
    principalAmount: number;
    principalToken: string;
    collateralAmount: number;
    collateralToken: string;
    interestRate: number;
    termDuration: number;
    termUnit: DurationUnit;
    debtorAddress: string;
    expiresInDuration: number;
    expiresInUnit: DurationUnit;
}

export class LoanRequest extends BaseLoan {
    /**
     * Eventually returns an instance of a loan request signed by the debtor.
     *
     * @example
     * const loanRequest = await LoanRequest.create(dharma, {
     *      principalAmount: 5,
     *      principalToken: "REP",
     *      collateralAmount: 10,
     *      collateralToken: "MKR",
     *      interestRate: 12.3,
     *      termDuration: 6,
     *      termUnit: "months",
     *      debtorAddress: debtor.address,
     *      expiresInDuration: 5,
     *      expiresInUnit: "days",
     *  });
     *
     * @returns {Promise<LoanRequest>}
     */
    public static async create(dharma: Dharma, params: LoanRequestParams): Promise<LoanRequest> {
        const {
            principalAmount,
            principalToken,
            collateralAmount,
            collateralToken,
            interestRate,
            termDuration,
            termUnit,
            debtorAddress,
            expiresInDuration,
            expiresInUnit,
        } = params;

        const principal = new TokenAmount(principalAmount, principalToken);
        const collateral = new TokenAmount(collateralAmount, collateralToken);
        const interestRateTyped = new InterestRate(interestRate);
        const termLength = new TimeInterval(termDuration, termUnit);
        const debtorAddressTyped = new EthereumAddress(debtorAddress);
        const expiresIn = new TimeInterval(expiresInDuration, expiresInUnit);

        const currentBlocktime = new BigNumber(await dharma.blockchain.getCurrentBlockTime());

        const expirationTimestampInSec = expiresIn.fromTimestamp(currentBlocktime);

        const loanRequestConstructorParams: BaseLoanConstructorParams = {
            principal,
            collateral,
            interestRate: interestRateTyped,
            termLength,
            debtorAddress: debtorAddressTyped,
            expiresAt: expirationTimestampInSec.toNumber(),
        };

        const loanOrder: CollateralizedSimpleInterestLoanOrder = {
            principalAmount: principal.rawAmount,
            principalTokenSymbol: principal.tokenSymbol,
            interestRate: interestRateTyped.raw,
            amortizationUnit: termLength.getAmortizationUnit(),
            termLength: new BigNumber(termLength.amount),
            collateralTokenSymbol: collateral.tokenSymbol,
            collateralAmount: collateral.rawAmount,
            gracePeriodInDays: new BigNumber(0),
            expirationTimestampInSec,
        };

        const data = await dharma.adapters.collateralizedSimpleInterestLoan.toDebtOrder(loanOrder);
        const debtKernel = await dharma.contracts.loadDebtKernelAsync();
        const repaymentRouter = await dharma.contracts.loadRepaymentRouterAsync();
        const salt = this.generateSalt();

        data.debtor = debtorAddressTyped.toString();
        data.kernelVersion = debtKernel.address;
        data.issuanceVersion = repaymentRouter.address;
        data.salt = salt;

        const loanRequest = new LoanRequest(dharma, loanRequestConstructorParams, data);

        await loanRequest.signAsDebtor();

        return loanRequest;
    }

    public static async load(dharma: Dharma, data: DebtOrderData): Promise<LoanRequest> {
        const loanOrder = await dharma.adapters.collateralizedSimpleInterestLoan.fromDebtOrder(
            data,
        );

        const principal = TokenAmount.fromRaw(
            loanOrder.principalAmount,
            loanOrder.principalTokenSymbol,
        );

        const collateral = TokenAmount.fromRaw(
            loanOrder.collateralAmount,
            loanOrder.collateralTokenSymbol,
        );

        const interestRate = InterestRate.fromRaw(loanOrder.interestRate);

        const termLength = new TimeInterval(
            loanOrder.termLength.toNumber(),
            loanOrder.amortizationUnit,
        );

        const debtorAddress = new EthereumAddress(loanOrder.debtor!); // TODO(kayvon): this could throw.

        const loanRequestParams = {
            principal,
            collateral,
            termLength,
            interestRate,
            expiresAt: loanOrder.expirationTimestampInSec.toNumber(),
            debtorAddress,
        };

        return new LoanRequest(dharma, loanRequestParams, data);
    }

    /**
     * Eventually returns an instance of a loan iff the loan is filled.
     *
     * @example
     * const loan = await LoanRequest.generateLoan();
     *
     * @returns {Promise<Loan>}
     */
    public async generateLoan(): Promise<Loan> {
        const isFilled = await this.isFilled();

        if (!isFilled) {
            throw new Error("The loan request has yet to be filled on the blockchain.");
        }

        return new Loan(this.dharma, this.params, this.data);
    }

    /**
     * Eventually enables the account at the default address to transfer the collateral token
     * on Dharma Protocol.
     *
     * @example
     * await loanRequest.allowCollateralTransfer();
     * => "0x000..."
     *
     * @returns {Promise<string>} the hash of the Ethereum transaction to enable the token transfers
     */
    public async allowCollateralTransfer(debtorAddress?: string): Promise<string> {
        const debtor = debtorAddress || this.params.debtorAddress.toString();

        const ethereumAddress = new EthereumAddress(debtor);

        const tokenSymbol = this.params.collateral.tokenSymbol;

        return this.enableTokenTransfers(ethereumAddress, tokenSymbol);
    }

    /**
     * Eventually enables the account at the default address to transfer the principal token
     * on Dharma Protocol.
     *
     * @example
     * await loanRequest.allowPrincipalTransfer();
     * => "0x000..."
     *
     * @returns {Promise<string>} the hash of the Ethereum transaction to enable the token transfers
     */
    public async allowPrincipalTransfer(creditorAddress?: string): Promise<string> {
        const creditor = creditorAddress || (await this.getCurrentUser());

        const ethereumAddress = new EthereumAddress(creditor);

        const networkId = await this.dharma.blockchain.getNetworkId();

        if (
            networkId === 1 &&
            ethereumAddress.toString() === this.params.debtorAddress.toString()
        ) {
            throw new Error("The creditor's address cannot be the same as the debtor's address.");
        }

        const tokenSymbol = this.params.principal.tokenSymbol;

        return this.enableTokenTransfers(ethereumAddress, tokenSymbol);
    }

    /**
     * Eventually returns true if the current debt order will be expired for the next block.
     *
     * @example
     * await loanRequest.isExpired();
     * => true
     *
     * @returns {Promise<boolean>}
     */
    public async isExpired(): Promise<boolean> {
        // This timestamp comes from the blockchain.
        const expirationTimestamp: BigNumber = this.data.expirationTimestampInSec;
        // We compare this timestamp to the expected timestamp of the next block.
        const latestBlockTime = await this.getCurrentBlocktime();
        const approximateNextBlockTime = latestBlockTime + BLOCK_TIME_ESTIMATE_SECONDS;

        return expirationTimestamp.lt(approximateNextBlockTime);
    }

    public isSignedByDebtor(): boolean {
        return this.data.debtorSignature !== NULL_ECDSA_SIGNATURE;
    }

    public async signAsDebtor() {
        if (this.isSignedByDebtor()) {
            return;
        }

        this.data.debtorSignature = await this.dharma.sign.asDebtor(this.data, false);
    }

    /**
     * Eventually returns true if the current debt order has been cancelled.
     *
     * @example
     * await loanRequest.isCancelled();
     * => true
     *
     * @returns {Promise<boolean>}
     */
    public async isCancelled(): Promise<boolean> {
        return this.dharma.order.isCancelled(this.data);
    }

    /**
     * Eventually attempts to cancel the current debt order. A debt order can be cancelled by the debtor
     * if it is open and unfilled.
     *
     * @example
     * await loanRequest.cancelAsDebtor();
     * => "0x000..."
     *
     * @returns {Promise<string>} the hash of the Ethereum transaction to cancel the debt order
     */
    public async cancelAsDebtor(): Promise<string> {
        return this.dharma.order.cancelOrderAsync(this.data, {
            from: this.data.debtor,
        });
    }

    /**
     * Eventually returns true if the current debt order has been filled by a creditor.
     *
     * @example
     * await loanRequest.isFilled();
     * => true
     *
     * @returns {Promise<boolean>}
     */
    public async isFilled(): Promise<boolean> {
        return this.dharma.order.checkOrderFilledAsync(this.data);
    }

    /**
     * Eventually fills the debt order, transferring the principal to the debtor.
     *
     * @example
     * order.fill();
     * => Promise<string>
     *
     * @returns {Promise<string>} the hash of the Ethereum transaction to fill the debt order
     */
    public async fill(creditorAddress?: string): Promise<string> {
        const creditor = creditorAddress || (await this.getCurrentUser());

        const creditorAddressTyped = new EthereumAddress(creditor);

        this.data.creditor = creditorAddressTyped.toString();

        await this.signAsCreditor();

        return this.dharma.order.fillAsync(this.data, { from: this.data.creditor });
    }

    private isSignedByCreditor(): boolean {
        return this.data.creditorSignature !== NULL_ECDSA_SIGNATURE;
    }

    private async signAsCreditor(): Promise<void> {
        if (this.isSignedByCreditor()) {
            return;
        }

        this.data.creditorSignature = await this.dharma.sign.asCreditor(this.data, false);
    }
}