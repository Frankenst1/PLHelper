import globals from "globals";
import pluginJs from "@eslint/js";
import userscripts from "eslint-plugin-userscripts";

export default [
    {
        files: ['*.user.js'],
        languageOptions: {
            sourceType: "script",
            globals: {
                ...globals.browser,
                GM_info: "readonly",
                GM_addStyle: "readonly",
                GM_getValue: "readonly",
                GM_setValue: "readonly",
                GM_deleteValue: "readonly",
                GM_listValues: "readonly",
                GM_openInTab: "readonly",
                GM_registerMenuCommand: "readonly",
            },
        },
        plugins: {
            userscripts,
        },
        rules: {
            ...pluginJs.configs.recommended.rules,
            ...userscripts.configs.recommended.rules,
        },
    },
];