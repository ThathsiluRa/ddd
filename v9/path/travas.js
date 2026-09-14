// Compatibility shim for legacy handler references.
//
// The original project imported disruptive WhatsApp payload functions from this
// module. Those functions are intentionally not distributed in the safe build.
// Keeping a rejecting proxy lets the rest of the bot start while guaranteeing
// that any missed legacy reference fails closed without sending a payload.

const disabledAction = async () => {
    throw new Error("Disruptive WhatsApp payload functionality is disabled.");
};

const disabledTravas = new Proxy(Object.create(null), {
    get() {
        return disabledAction;
    },
    set() {
        return false;
    },
});

export default disabledTravas;
