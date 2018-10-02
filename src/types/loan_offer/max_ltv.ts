import { RepaymentRouter } from "@dharmaprotocol/contracts";

import * as singleLineString from "single-line-string";

import { Web3Utils } from "../../../utils/web3_utils";

import { DebtOrderParams } from "../../loan/debt_order";

import { SignatureUtils } from "../../../utils/signature_utils";

import { NULL_ADDRESS, NULL_ECDSA_SIGNATURE, SALT_DECIMALS } from "../../../utils/constants";

import { Dharma } from "../dharma";

import {
    DebtOrderData,
    ECDSASignature,
    EthereumAddress,
    InterestRate,
    TimeInterval,
    TokenAmount,
} from "../";

import { SignedPrice } from "./signed_price";

import { BigNumber } from "../../../utils/bignumber";

const MAX_INTEREST_RATE_PRECISION = 4;
const FIXED_POINT_SCALING_FACTOR = 10 ** MAX_INTEREST_RATE_PRECISION;

export const MAX_LTV_LOAN_OFFER_ERRORS = {
    ALREADY_SIGNED_BY_DEBTOR: () => `The debtor has already signed the loan offer.`,
    COLLATERAL_AMOUNT_NOT_SET: () => `The collateral amount must be set first`,
    INSUFFICIENT_COLLATERAL_AMOUNT: (collateralAmount: number, collateralTokenSymbol: string) =>
        singleLineString`Collateral of ${collateralAmount} ${collateralTokenSymbol} is insufficient
            for the maximum loan-to-value.`,
    PRICES_NOT_SET: () => `The prices of the principal and collateral must be set first.`,
};

export interface MaxLTVData {
    collateralTokenAddress: string;
    collateralTokenSymbol: string;
    creditorFee?: BigNumber;
    debtorFee?: BigNumber;
    expiresIn: TimeInterval;
    interestRate: InterestRate;
    issuanceVersion: string;
    kernelVersion: string;
    maxLTV: BigNumber;
    priceProvider: string;
    principal: TokenAmount;
    principalTokenAddress: string;
    relayer?: EthereumAddress;
    relayerFee?: TokenAmount;
    termLength: TimeInterval;
    termsContract: string;
}

export interface MaxLTVParams extends DebtOrderParams {
    maxLTV: number;
    collateralToken: string;
    priceProvider: string;
    debtorFeeAmount?: number;
}

export class MaxLTVLoanOffer {
    // TODO: replace with decision engine address (async function?)
    public static decisionEngineAddress = "test";

    public static async create(dharma: Dharma, params: MaxLTVParams): Promise<MaxLTVLoanOffer> {
        const {
            collateralToken,
            creditorFeeAmount,
            debtorFeeAmount,
            expiresInDuration,
            expiresInUnit,
            interestRate,
            maxLTV,
            priceProvider,
            principalAmount,
            principalToken,
            relayerAddress,
            relayerFeeAmount,
            termDuration,
            termUnit,
        } = params;

        const kernelVersion = (await dharma.contracts.loadDebtKernelAsync()).address;
        const issuanceVersion = (await dharma.contracts.loadRepaymentRouterAsync()).address;
        const termsContract = (await dharma.contracts.loadCollateralizedSimpleInterestTermsContract())
            .address;
        const principalTokenAddress = await dharma.contracts.getTokenAddressBySymbolAsync(
            principalToken,
        );
        const collateralTokenAddress = await dharma.contracts.getTokenAddressBySymbolAsync(
            collateralToken,
        );

        const data: MaxLTVData = {
            collateralTokenAddress,
            collateralTokenSymbol: collateralToken,
            expiresIn: new TimeInterval(expiresInDuration, expiresInUnit),
            interestRate: new InterestRate(interestRate),
            issuanceVersion,
            kernelVersion,
            maxLTV: new BigNumber(maxLTV),
            priceProvider,
            principal: new TokenAmount(principalAmount, principalToken),
            principalTokenAddress,
            salt: MaxLTVLoanOffer.generateSalt(),
            termLength: new TimeInterval(termDuration, termUnit),
            termsContract,
        };

        if (relayerAddress && relayerFeeAmount) {
            data.relayer = new EthereumAddress(relayerAddress);
            data.relayerFee = new TokenAmount(relayerFeeAmount, principalToken);
        }

        if (creditorFeeAmount && creditorFeeAmount > 0) {
            const creditorFeeTokenAmount = new TokenAmount(creditorFeeAmount, principalToken);
            data.creditorFee = creditorFeeTokenAmount.rawAmount;
        }

        if (debtorFeeAmount && debtorFeeAmount > 0) {
            const debtorFeeTokenAmount = new TokenAmount(debtorFeeAmount, principalToken);
            data.debtorFee = debtorFeeTokenAmount.rawAmount;
        }

        return new MaxLTVLoanOffer(dharma, data);
    }

    public static async createAndSignAsCreditor(
        dharma: Dharma,
        params: MaxLTVParams,
        creditor?: string,
    ): Promise<MaxLTVLoanOffer> {
        const offer = await MaxLTVLoanOffer.create(dharma, params);

        await offer.signAsCreditor(creditor);

        return offer;
    }

    public static generateSalt(): BigNumber {
        return BigNumber.random(SALT_DECIMALS).times(new BigNumber(10).pow(SALT_DECIMALS));
    }

    private readonly data: MaxLTVData;

    private creditor?: string;
    private creditorSignature?: ECDSASignature;
    private debtorSignature?: ECDSASignature;
    private collateralAmount?: number;
    private principalPrice?: SignedPrice;
    private collateralPrice?: SignedPrice;
    private debtor?: string;
    private expirationTimestampInSec?: BigNumber;

    constructor(private readonly dharma: Dharma, private readonly data: MaxLTVData) {}

    /**
     * Eventually signs the loan offer as the creditor.
     *
     * @throws Throws if the loan offer is already signed by a creditor.
     *
     * @example
     * loanOffer.signAsCreditor();
     * => Promise<void>
     *
     * @return {Promise<void>}
     */
    public async signAsCreditor(creditorAddress?: string): Promise<void> {
        // TODO: check if already signed by creditor

        this.creditor = await EthereumAddress.validAddressOrCurrentUser(
            this.dharma,
            creditorAddress,
        );

        // Set the expiration timestamp
        const currentBlocktime = new BigNumber(await this.dharma.blockchain.getCurrentBlockTime());

        this.expirationTimestampInSec = this.data.expiresIn.fromTimestamp(currentBlocktime);

        const loanOfferHash = this.getCreditorCommitmentHash();

        const isMetaMask = !!this.dharma.web3.currentProvider.isMetaMask;

        this.creditorSignature = await this.dharma.sign.signPayloadWithAddress(
            loanOfferHash,
            this.creditor,
            isMetaMask,
        );
    }

    /**
     * Returns whether the loan offer has been signed by a creditor.
     *
     * @example
     * loanOffer.isSignedByCreditor();
     * => true
     *
     * @return {boolean}
     */
    public isSignedByCreditor(): boolean {
        if (
            this.creditorSignature &&
            SignatureUtils.isValidSignature(
                this.getCreditorCommitmentHash(),
                this.creditorSignature,
                this.creditor,
            )
        ) {
            return true;
        }

        return false;
    }

    public setPrincipalPrice(principalPrice: SignedPrice) {
        // TODO: assert signed price feed provider address is the address we expect
        // TODO: assert signed time is within some delta of current time (?)
        this.principalPrice = principalPrice;
    }

    public getPrincipalPrice(): SignedPrice {
        return this.principalPrice;
    }

    public setCollateralPrice(collateralPrice: SignedPrice) {
        // TODO: assert signed price feed provider address is the address we expect
        // TODO: assert signed time is within some delta of current time (?)
        this.collateralPrice = collateralPrice;
    }

    public getCollateralPrice(): SignedPrice {
        return this.principalPrice;
    }

    public setCollateralAmount(collateralAmount: number) {
        // TODO: assert prices are set
        // TODO: assert collateralAmount sufficient
        this.collateralAmount = collateralAmount;
    }

    public getCollateralAmount(): number {
        return this.collateralAmount;
    }

    public async signAsDebtor(debtorAddress?: string): Promise<void> {
        if (this.isSignedByDebtor()) {
            throw new Error(MAX_LTV_LOAN_OFFER_ERRORS.ALREADY_SIGNED_BY_DEBTOR());
        }

        if (!this.principalPrice || !this.collateralPrice) {
            throw new Error(MAX_LTV_LOAN_OFFER_ERRORS.PRICES_NOT_SET());
        }

        if (!this.collateralAmount) {
            throw new Error(MAX_LTV_LOAN_OFFER_ERRORS.COLLATERAL_AMOUNT_NOT_SET());
        }

        // TODO: assert signed address matches principal token address
        // TODO: assert signed address matches collateral token address

        if (!this.collateralAmountIsSufficient()) {
            throw new Error(
                MAX_LTV_LOAN_OFFER_ERRORS.INSUFFICIENT_COLLATERAL_AMOUNT(
                    this.collateralAmount,
                    this.data.collateralTokenSymbol,
                ),
            );
        }

        this.debtor = await EthereumAddress.validAddressOrCurrentUser(this.dharma, debtorAddress);

        const isMetaMask = !!this.dharma.web3.currentProvider.isMetaMask;

        const debtorCommitmentHash = this.getDebtorCommitHash();

        this.debtorSignature = await this.dharma.sign.signPayloadWithAddress(
            debtorCommitmentHash,
            this.debtor,
            isMetaMask,
        );
    }

    /**
     * Returns whether the loan offer has been signed by a debtor.
     *
     * @example
     * loanOffer.isSignedByDebtor();
     * => true
     *
     * @return {boolean}
     */
    public isSignedByDebtor(): boolean {
        if (
            this.debtorSignature &&
            SignatureUtils.isValidSignature(
                this.getDebtorCommitHash(),
                this.debtorSignature,
                this.debtor,
            )
        ) {
            return true;
        }

        return false;
    }

    public async acceptAsDebtor(): Promise<void> {
        // TODO: send transaction to CreditorProxtContract
    }

    private getCreditorCommitmentTermsHash(): string {
        return Web3Utils.soliditySHA3(
            this.data.kernelVersion,
            this.data.issuanceVersion,
            this.data.termsContract,
            this.data.principal.rawAmount,
            this.data.principalTokenAddress,
            this.data.collateralTokenAddress,
            this.data.maxLTV,
            this.data.interestRate.raw.mul(FIXED_POINT_SCALING_FACTOR),
            this.data.debtorFee ? this.data.debtorFee : new BigNumber(0),
            this.data.creditorFee ? this.data.creditorFee : new BigNumber(0),
            this.data.relayer ? this.data.relayer.toString() : NULL_ADDRESS,
            this.data.relayerFee ? this.data.relayerFee : new BigNumber(0),
            this.expirationTimestampInSec,
            this.data.salt,
        );
    }

    private getCreditorCommitmentHash(): string {
        return Web3Utils.soliditySHA3(
            MaxLTVLoanOffer.decisionEngineAddress,
            this.getCreditorCommitmentTermsHash(),
        );
    }

    private getIssuanceCommitmentHash(): string {
        return Web3Utils.soliditySHA3(
            this.data.issuanceVersion,
            this.debtor,
            this.data.underwriter,
            this.data.underwriterRiskRating,
            this.data.termsContract,
            this.data.termsContractParameters,
            this.data.salt,
        );
    }

    private getDebtorCommitHash(): string {
        // TODO: remove mock implementation
        return Web3Utils.soliditySHA3("mockDebtorCommitmentHash");

        return Web3Utils.soliditySHA3(
            this.data.kernelVersion,
            this.getIssuanceCommitmentHash(),
            this.data.underwriterFee,
            this.data.principal.rawAmount,
            this.data.principalToken,
            this.data.debtorFee,
            this.data.creditorFee,
            this.data.relayer,
            this.data.relayerFee,
            this.expirationTimestampInSec,
        );
    }

    private collateralAmountIsSufficient(): boolean {
        if (!this.collateralAmount || !this.principalPrice || !this.collateralPrice) {
            return false;
        }

        // We do not use the TokenAmount's rawValue here because what matters is the "real world" amount
        // of the principal and collateral, without regard for how many decimals are used in their
        // blockchain representations.
        const principalValue = new BigNumber(this.data.principal.decimalAmount).times(
            this.principalPrice.tokenPrice,
        );

        const collateralValue = new BigNumber(this.collateralAmount).times(
            this.collateralPrice.tokenPrice,
        );

        return principalValue.div(collateralValue).lte(this.data.maxLTV.div(100));
    }
}
