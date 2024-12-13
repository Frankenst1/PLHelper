// ==UserScript==
// @name         PLHelper
// @description  Makes downloading PL torrents easier, as well as having some more clarity on some pages.
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @author       Frankenst1
// @match        https://pornolab.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pornolab.net
// @updateURL    https://raw.githubusercontent.com/Frankenst1/PLHelper/main/user.script.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankenst1/PLHelper/main/user.script.user.js
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// ==/UserScript==

// TODO: ability to change settings (ability to set preferences (video quality, tags, ...)).
// TODO: add proper debugging.
// TODO: add ability to start downloading the torrents as well?
// TODO: move these constants to a "profile settings" page.
// TODO: handleFormPage and handleTorrentPage have a very similar body. Might be a good idea to have it more abstract and reuse methods between the two for maintainability.
(function () {
    'use strict';
    // ==Configuration==
    const Config = {
        TIMEZONE_OFFSET: (24 + (new Date().getTimezoneOffset() + (3 * 60)) / 60) % 24,
        AVAILABLE_VIDEO_FORMATS: ["1080", "720", "4K", "2160"],
        URL_DELAY: 1000,
        SIZE_UNITS: ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        STORAGE_KEYS: {
            PROFILE: 'profile',
            SETTINGS: 'settings',
            DOWNLOADED_TORRENTS: 'downloadedTorrents'
        },
        DEBUG_MODE: true
    };

    // ==Utilities==
    const Utils = {
        logDebug(message) {
            if (Config.DEBUG_MODE) {
                console.debug(`[PLHelper Debug]: ${message}`);
            }
        },

        convertSizeBetweenUnits(value, fromUnit, toUnit) {
            const fromIndex = Config.SIZE_UNITS.indexOf(fromUnit);
            const toIndex = Config.SIZE_UNITS.indexOf(toUnit);

            if (fromIndex === -1 || toIndex === -1) {
                throw new Error('Invalid unit provided');
            }

            const bytes = value * Math.pow(1024, fromIndex);
            return Number((bytes / Math.pow(1024, toIndex)).toFixed(2));
        },

        isToday(date) {
            const today = new Date();
            return (
                date.getDate() === today.getDate() &&
                date.getMonth() === today.getMonth() &&
                date.getFullYear() === today.getFullYear()
            );
        },

        parseIdFromUrl(url, type) {
            let id;
            switch (type) {
                case 'topic':
                    id = url.split('?f=').pop();
                    break;
                case 'torrent':
                    id = url.split('?t=').pop();
                    break;
                default:
                    Utils.logDebug(`Invalid URL type: ${type}`);
                    return null;
            }
            return id;
        }
    };

    // ==Data Structures==
    class Torrent {
        constructor(id, title, pageUrl, size, topic, downloadDate = null) {
            this.id = id;
            this.title = title;
            this.pageUrl = pageUrl;
            this.size = size;
            this.topic = topic;
            this.downloadDate = downloadDate;
        }

        isDownloaded(downloadedTorrents) {
            return downloadedTorrents.some(torrent => torrent.id === this.id);
        }
    }

    // TODO: Shouldn't page URL not always be generated?
    class TorrentTopic {
        constructor(id, title, pageUrl = null) {
            this.id = id;
            this.title = title;
            this.pageUrl = pageUrl || `./forum/tracker.php?f=${id}`;
        }
    }

    class Profile {
        constructor(preferences = {}, stats = { ratio: 0, uploaded: 0, downloaded: 0 }, downloadedTorrents = []) {
            this.preferences = preferences;
            this.stats = stats;
            this.downloadedTorrents = downloadedTorrents;
        }

        addDownloadedTorrent(torrent) {
            this.downloadedTorrents.push(torrent);
        }

        updateStats(stats) {
            this.stats = { ...this.stats, ...stats };
        }
    }

    // ==Storage Manager==
    const StorageManager = {
        get(key, defaultValue) {
            return GM_getValue(key, defaultValue);
        },

        set(key, value) {
            GM_setValue(key, value);
        },

        delete(key) {
            GM_deleteValue(key);
        },

        loadProfile() {
            return this.get(Config.STORAGE_KEYS.PROFILE, new Profile());
        },

        saveProfile(profile) {
            this.set(Config.STORAGE_KEYS.PROFILE, profile);
        },

        loadDownloadedTorrents() {
            return this.get(Config.STORAGE_KEYS.DOWNLOADED_TORRENTS, []);
        },

        saveDownloadedTorrents(torrents) {
            this.set(Config.STORAGE_KEYS.DOWNLOADED_TORRENTS, torrents);
        },

        loadSettings() {
            return this.get(Config.STORAGE_KEYS.SETTINGS, {
                hideDownloadedTorrents: false,
                preferredFormats: Config.AVAILABLE_VIDEO_FORMATS
            });
        },

        saveSettings(settings) {
            this.set(Config.STORAGE_KEYS.SETTINGS, settings);
        }
    };

    // ==Torrent Mapper==
    const TorrentMapper = {
        mapTrackerToTorrent(trackerRow, profile) {
            return this.mapRowToTorrent(
                trackerRow,
                profile,
                'td:nth-of-type(3)', // Topic element selector
                'td:nth-of-type(4)', // Subject element selector
                'td:nth-of-type(6)'  // Size element selector
            );
        },

        mapFormPostToTorrent(formRow, profile) {
            if (/(announce)/.test(formRow.querySelector('img.topic_icon')?.src)) {
                return null; // Skip announcements
            }

            return this.mapRowToTorrent(
                formRow,
                profile,
                '#main_content_wrap .nav.nav-top a:last-of-type', // Topic element selector
                'td:nth-of-type(2)', // Subject element selector
                'td:nth-of-type(3) .dl-stub'  // Size element selector (fallback to 'unknown')
            );
        },

        mapRowToTorrent(row, profile, topicSelector, subjectSelector, sizeSelector) {
            const topicElement = row.querySelector(topicSelector);
            const topicUrl = topicElement?.href || topicElement?.querySelector('a')?.href;
            const topicId = Utils.parseIdFromUrl(topicUrl, 'topic');
            const topicTitle = topicElement?.textContent?.trim();
            const topic = new TorrentTopic(topicId, topicTitle, topicUrl);

            const subjectElement = row.querySelector(subjectSelector);
            const subject = subjectElement?.textContent?.trim();
            const url = subjectElement?.querySelector('a')?.href;
            const size = row.querySelector(sizeSelector)?.textContent?.trim() || 'unknown';
            const id = Utils.parseIdFromUrl(url, 'torrent');

            const torrent = new Torrent(id, subject, url, size, topic);

            // Filtering logic based on user preferences
            if (profile.preferences.hideDownloadedTorrents && torrent.isDownloaded(profile.downloadedTorrents)) {
                row.style.display = 'none';
                return null;
            }

            return torrent;
        }
    };

    // ==UI Helpers==
    const UIHelpers = {
        addTorrentOpenerUI(torrents) {
            const container = document.createElement('fieldset');
            container.className = 'torrent-opener-ui';
            container.innerHTML = '<legend>Torrent Opener</legend>';

            torrents.forEach(torrent => {
                const button = document.createElement('button');
                button.textContent = `Open: ${torrent.title}`;
                button.addEventListener('click', () => GM_openInTab(torrent.pageUrl, { active: true }));
                container.appendChild(button);
            });

            document.body.appendChild(container);
        },

        generateTorrentsTable(torrents) {
            const table = document.createElement('table');
            table.className = 'torrent-table';

            // Add table headers
            const headers = ['Title', 'Size', 'Topic'];
            const headerRow = document.createElement('tr');
            headers.forEach(headerText => {
                const headerCell = document.createElement('th');
                headerCell.textContent = headerText;
                headerRow.appendChild(headerCell);
            });
            table.appendChild(headerRow);

            // Add rows for each torrent
            torrents.forEach(torrent => {
                const row = document.createElement('tr');

                const titleCell = document.createElement('td');
                titleCell.textContent = torrent.title;
                row.appendChild(titleCell);

                const sizeCell = document.createElement('td');
                sizeCell.textContent = torrent.size;
                row.appendChild(sizeCell);

                const topicCell = document.createElement('td');
                topicCell.textContent = torrent.topic?.title || 'Unknown';
                row.appendChild(topicCell);

                table.appendChild(row);
            });

            return table;
        },

        generateStatsPanel(profile) {
            const statsContainer = document.createElement('div');
            statsContainer.className = 'stats-panel';

            statsContainer.innerHTML = `
            <p>Uploaded: ${Utils.convertSizeBetweenUnits(profile.stats.uploaded, 'B', 'GB')} GB</p>
            <p>Downloaded: ${Utils.convertSizeBetweenUnits(profile.stats.downloaded, 'B', 'GB')} GB</p>
            <p>Ratio: ${profile.stats.ratio.toFixed(2)}</p>
        `;

            return statsContainer;
        }
    };

    // ==Page Handlers==
    function handleProfilePage(profile) {
        const wrapper = document.querySelector('#main_content_wrap');
        if (!wrapper) return;

        // Generate torrents table
        const torrentsTable = UIHelpers.generateTorrentsTable(profile.downloadedTorrents);
        wrapper.appendChild(torrentsTable);

        // Generate stats panel
        const statsPanel = UIHelpers.generateStatsPanel(profile);
        wrapper.appendChild(statsPanel);

        // Save any updates to the profile
        StorageManager.saveProfile(profile);
    }

    function handleTrackerPage(profile) {
        const rows = document.querySelectorAll('#main_content table#tor-tbl tr.tCenter');
        const torrents = Array.from(rows)
            .map(row => TorrentMapper.mapTrackerToTorrent(row, profile))
            .filter(Boolean); // Remove nulls (filtered out torrents)

        // Add torrent opener UI
        UIHelpers.addTorrentOpenerUI(torrents);
    }

    function handleFormPage(profile) {
        const rows = document.querySelectorAll('#main_content table.forum tr[id]');
        const torrents = Array.from(rows)
            .map(row => TorrentMapper.mapFormPostToTorrent(row, profile))
            .filter(Boolean); // Remove nulls (filtered out torrents)

        // Add torrent opener UI
        UIHelpers.addTorrentOpenerUI(torrents);
    }

    function handleTorrentPage(profile) {
        const torrentId = Utils.parseIdFromUrl(location.search, 'torrent');
        const torrentTitle = document.querySelector('h1.maintitle')?.textContent?.trim();
        const torrentUrl = location.href;
        const torrentSize = document.querySelector('#main_content_wrap .dl_list tbody tr:nth-of-type(2) td b:nth-of-type(1)')?.textContent;

        const topicElement = document.querySelector("#main_content_wrap .nav a:nth-last-of-type(2)");
        const topicUrl = topicElement?.href;
        const topicId = Utils.parseIdFromUrl(topicUrl, 'topic');
        const topicTitle = topicElement?.textContent;
        const torrentTopic = new TorrentTopic(topicId, topicTitle, topicUrl);

        const torrent = new Torrent(torrentId, torrentTitle, torrentUrl, torrentSize, torrentTopic);

        // Update UI based on whether the torrent is downloaded
        document.body.style.backgroundColor = torrent.isDownloaded(profile.downloadedTorrents) ? 'red' : 'green';

        // Add event listener to download button
        const downloadButton = document.querySelector('#tor-reged .dl-stub.dl-link');
        if (downloadButton) {
            downloadButton.addEventListener('click', () => {
                if (!torrent.isDownloaded(profile.downloadedTorrents)) {
                    profile.addDownloadedTorrent(torrent);
                    StorageManager.saveProfile(profile);
                }
            });
        }
    }

    // OLD CODE PAST HERE (to check functionality).

    // ==Constants==
    const TIMEZONE_OFFSET = (24 + (new Date().getTimezoneOffset() + (3 * 60)) / 60) % 24;
    const AVAILABLE_VIDEO_FORMATS = ["1080", "720", "4K", "2160"];
    const URL_DELAY = 1000;
    const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    // Storage keys
    const PROFILE_KEY = 'profile';
    // ==/Constants==

    // ==Classes==
    class ProfilePreferences {
        constructor(hideDownloadedTorrents = [], videoFormats = []) {
            this.hideDownloadedTorrents = hideDownloadedTorrents;
            this.videoFormats = videoFormats
        }
    }
    // ==/Classes==

    // ==CSS==
    GM_addStyle('.lds-ripple { display: inline-block; position: relative; width: 80px; height: 80px; } .lds-ripple div { position: absolute; border: 4px solid #000; opacity: 1; border-radius: 50%; animation: lds-ripple 1s cubic-bezier(0, 0.2, 0.8, 1) infinite; } .lds-ripple div:nth-child(2) { animation-delay: -0.5s; } @keyframes lds-ripple { 0% { top: 36px; left: 36px; width: 0; height: 0; opacity: 0; } 4.9% { top: 36px; left: 36px; width: 0; height: 0; opacity: 0; } 5% { top: 36px; left: 36px; width: 0; height: 0; opacity: 1; } 100% { top: 0px; left: 0px; width: 72px; height: 72px; opacity: 0; } }');
    GM_addStyle('.progress-bar-container { color: #000 !important; background-color: darkgrey !important; } .progress-bar { color: #fff !important; background-color: #607d8b !important; text-align: center; } .progress-bar::after, .progress-bar::before { content: ""; display: table; clear: both; } .progress-bar *:not(span):not(font) { min-width: 60px; display: inline-block; }');
    // ==/CSS==

    // ==Helper methods==
    // Returns "true" if on the correct page.
    function checkPage(page) {
        let cp = location.pathname;
        switch (page) {
            case 'profile_page':
                return cp.includes('profile.php') && document.getElementById('passkey-val');
            case 'tracker_page':
                return cp.includes('tracker.php');
            case 'topic_page':
                return cp.includes('viewtopic.php') && location.search.includes('?t=') && document.querySelector('.dl-link') !== null;
            case 'form_page':
                return cp.includes('viewforum.php');
            default:
                return false;
        }
    }

    function isToday(dateToCheck) {
        // Get today's date
        const today = new Date();

        // Compare the components of the dateToCheck with today's date
        const isSameDate =
            dateToCheck.getDate() === today.getDate() &&
            dateToCheck.getMonth() === today.getMonth() &&
            dateToCheck.getFullYear() === today.getFullYear();

        // Return true if the dateToCheck is today, otherwise return false
        return isSameDate;
    }

    function isTorrentAlreadyDownloaded(torrentId) {
        const downloadedTorrents = getAllDownloadedTorrents();
        return downloadedTorrents.some((obj) => obj.id == torrentId);
    }

    function getAllDownloadedTorrents() {
        const profile = GM_getValue(PROFILE_KEY);

        return profile.downloadedTorrents;
    }

    function getProfilePreferences() {
        const profile = getProfile();

        return profile.preferences;
    }

    function setProfilePreferences(profilePreferences) {
        const profile = getProfile();
        profile.preferences = profilePreferences;
        updateProfile(profile);
    }

    function getPreference(key) {
        const preferences = getProfilePreferences();
        if (Object.prototype.hasOwnProperty.call(preferences, key)) {
            return preferences[key];
        }

        return undefined;
    }

    function getProfile() {
        const profile = GM_getValue(PROFILE_KEY);

        return profile;
    }

    function updateProfile(profile) {
        GM_setValue(PROFILE_KEY, profile);

        console.debug("Profile was updated.");
    }

    function getIdFromUrl(url, type) {
        let id = null;
        switch (type) {
            case 'topic':
                id = url.split('?f=').pop();
                break;
            case 'torrent':
                id = url.split('?t=').pop();
                break;
            default:
                id = false;
                break;
        }

        if (id === url) {
            console.debug(`Invalid URL (${url}) for type (${type}).`);
            return false;
        }

        return id;
    }

    function getTorrentPage(torrent) {
        return `./viewtopic.php?t=${torrent.id}`;
    }

    function getTorrentDownloadLink(torrent) {
        return `dl.php?t=${torrent.id}`;
    }

    function getDownloadQuotaForProfile() {
        // TODO: fetch/store this data from GM_setValue() with profile data. This allows us to call this method from non-profile pages as well (maybe show on tracker overview).
        const currentRatio = document.querySelector('#u_ratio b.gen')?.innerText;
        let downTotal = document.querySelector("#u_down_total span")?.innerHTML.split("&nbsp;");
        let upTotal = document.querySelector("#u_up_total span")?.innerHTML.split("&nbsp;");
        downTotal = convertSizeBetweenUnits(downTotal[0], downTotal[1], "GB");
        upTotal = convertSizeBetweenUnits(upTotal[0], upTotal[1], "GB");

        return calculateDownloadLimit(upTotal, downTotal, currentRatio);
    }

    function filterEmptyOrFalseTorrent(array) {
        return array.filter(value => value !== false && value !== undefined && value !== null);
    }

    function calculateNearestRatio(ratio) {
        const ratios = [1, 0.5, 0.3];
        let nearestRatio = 0;

        for (let i = 0; i < ratios.length; i++) {
            if (ratio < ratios[i]) {
                nearestRatio = ratios[i];
            } else if (ratio === ratios[i]) {
                nearestRatio = ratios[i - 1] || ratios[i];
            } else {
                break;
            }
        }

        return nearestRatio;
    }

    function calculateRequiredUploadRatio(down, up, ratio) {
        const currentRatio = up / down;

        if (currentRatio >= ratio) {
            return 0;
        }

        const requiredUpload = ratio * down - up;
        return requiredUpload;
    }

    function calculateRemainingDownloadQuota() {
        const nDownloaded = calculateDownloadedToday();

        // Get accurate data and update it when we are on profile. Otherwise, use last known data (from profile storage).
        let downloadQuota;
        if (checkPage('profile_page')) {
            downloadQuota = getDownloadQuotaForProfile();
        } else {
            const profile = getProfile();
            const gbUploaded = convertSizeBetweenUnits(profile.ratio.uploaded, 'B', 'GB');
            const gbDownloaded = convertSizeBetweenUnits(profile.ratio.downloaded, 'B', 'GB');

            downloadQuota = calculateDownloadLimit(gbUploaded, gbDownloaded, profile.ratio.ratio)
        }

        return downloadQuota - nDownloaded;
    }

    function calculateDownloadedToday() {
        const downloadedTorrents = getAllDownloadedTorrents();
        const today = new Date();
        const todayItems = downloadedTorrents.filter(torrent => {
            const torrentDate = new Date(torrent.downloadDate);
            return torrentDate.getDate() === today.getDate() &&
                torrentDate.getMonth() === today.getMonth() &&
                torrentDate.getFullYear() === today.getFullYear();
        });

        return todayItems.length;
    }

    function calculateDownloadLimit(gbUploaded, gbDownloaded, ratio) {
        if (ratio >= 1.0) {
            if (gbUploaded >= 100) {
                return 100;
            } else {
                return 50;
            }
        } else if (ratio >= 0.5) {
            return 50;
        } else if (ratio >= 0.3) {
            return 10;
        } else if (gbDownloaded < 2) {
            return 5;
        } else {
            return 0;
        }
    }

    function calculateTimeUntilServerReset(asObject = false) {
        const midnightMSK = getDateMidnightMSK();
        const currentTimeMSK = getServerTime();

        const timeDifference = midnightMSK - currentTimeMSK;

        const hours = Math.floor(timeDifference / (1000 * 60 * 60));
        const minutes = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeDifference % (1000 * 60)) / 1000);

        function getServerTime() {
            const mskOffset = getMSKOffset();
            const now = Date.now();
            const currentTimeMSK = new Date(now + mskOffset);

            return currentTimeMSK;
        }

        // TODO: rework this, there is already something similar existing with the freeleech calculator.
        function getDateMidnightMSK() {
            const mskOffset = getMSKOffset();
            const now = Date.now();
            const currentTimeMSK = new Date(now + mskOffset);

            const midnightMSK = new Date(currentTimeMSK);
            midnightMSK.setUTCHours(21, 0, 0, 0); // 21 corresponds to 00:00 MSK because MSK is UTC+3

            return midnightMSK;
        }

        function getMSKOffset() {
            const date = new Date();
            return date.getTimezoneOffset() * -1; // Convert to positive
        }

        if (asObject) {
            return { hours: hours, minutes: minutes, seconds: seconds };
        }

        return `${hours} hours, ${minutes} minutes, ${seconds} seconds`;
    }

    function countDownloadedToday() {
        const downloadedTorrents = getAllDownloadedTorrents();
        const today = new Date();
        const todayItems = downloadedTorrents.filter(torrent => {
            const torrentDate = new Date(torrent.downloadDate);
            return torrentDate.getDate() === today.getDate() &&
                torrentDate.getMonth() === today.getMonth() &&
                torrentDate.getFullYear() === today.getFullYear();
        });

        return todayItems.length;
    }

    function convertSizeBetweenUnits(value, fromUnit, toUnit) {
        const fromIndex = SIZE_UNITS.indexOf(fromUnit);
        const toIndex = SIZE_UNITS.indexOf(toUnit);

        if (fromIndex === -1 || toIndex === -1) {
            throw new Error('Invalid unit provided');
        }

        const bytes = value * Math.pow(1024, fromIndex);
        const convertedValue = bytes / Math.pow(1024, toIndex);

        return Number(convertedValue.toFixed(2));
    }

    function formatBytes(value) {
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
            value /= 1024;
            unitIndex++;
        }

        const formattedValue = Number(value.toFixed(2));
        const unit = SIZE_UNITS[unitIndex];

        return `${formattedValue} ${unit}`;
    }

    function resetAllData() {
        const confirmReset = confirm("Reset all to default settings? This cannot be undone.");
        if (confirmReset) {
            GM_deleteValue(PROFILE_KEY);
            location.reload();
        }
    }
    // ==/Helper methods==

    // ==DOM methods==
    function generateArrayOfDownloadButtons(torrents, elementsId = 'torrent-open-tab') {
        const downloadButtons = [];

        // TODO: move to different method! + rework for readability.
        Object.keys(torrents).forEach((key, index) => {
            if (
                typeof torrents[key] === 'object' &&
                !Array.isArray(torrents[key]) &&
                torrents[key] !== null
            ) {
                const nested = generateArrayOfDownloadButtons(torrents[key], `torrent-open-tab-group-${key}`);
                downloadButtons.push(...nested);

                return;
            }
            const filter = key;
            const length = torrents[filter]?.length ?? 0;
            const eta = new Date(Date.now() + (length * URL_DELAY)).toLocaleString();

            const progressBarId = `${elementsId}-progress-bar-${index}`;
            const progressBar = generateProgressBar(0, progressBarId, key);

            const dwndBtnCallback = (e) => {
                e.preventDefault();

                console.debug(`Start opening tabs (ETA: ${eta})`);
                const matches = torrents[filter];
                matches.forEach((torrent, index) => {
                    setTimeout(() => {
                        const percentage = Math.floor((index + 1) / length * 100);
                        console.debug(`Downloading ${index + 1}/${length} (${percentage}%) - ${torrent.pageUrl}`);
                        GM_openInTab(torrent.pageUrl);

                        const torrentLink = document.querySelector(`a[href="./viewtopic.php?t=${torrent.id}"]`);
                        torrentLink.style.textDecoration = 'line-through';

                        updateProgressBar(progressBarId, percentage);
                    }, index * URL_DELAY);
                });
            };

            downloadButtons.push({
                button: generateButton('bold clickable', `Download ${length} items (${filter}).`, dwndBtnCallback),
                progressBar: progressBar
            });
        });

        return downloadButtons;
    }

    function generateProgressBar(percentage, id, helperText = null) {
        // Create the outer container div
        const containerDiv = document.createElement('div');
        containerDiv.className = 'progress-bar-container';
        containerDiv.id = id;

        // Create the inner progress bar div
        const progressBarDiv = document.createElement('div');
        progressBarDiv.className = 'progress-bar';
        progressBarDiv.style.width = `${percentage}%`;
        progressBarDiv.style.padding = 0;

        const progressBarValue = document.createElement('span');
        progressBarValue.classList.add('progress-bar-value');
        progressBarValue.textContent = `${percentage}%`;
        progressBarDiv.appendChild(progressBarValue);
        if (helperText) {
            const progressBarText = document.createElement('span');
            progressBarText.textContent = `(${helperText})`;
            progressBarDiv.appendChild(progressBarText);
        }

        // Append the inner progress bar div to the outer container div
        containerDiv.appendChild(progressBarDiv);

        return containerDiv;
    }

    function generateButton(btnClasses, btnText, callback) {
        const button = document.createElement('input');
        const btnType = 'submit';

        button.className = btnClasses;
        button.value = btnText;
        button.type = btnType;
        button.style.width = '200px';
        button.style.marginTop = '26px';
        button.style.marginBottom = '10px';
        button.addEventListener('click', callback);

        return button;
    }

    function generateLegend(legendText, htmlContent = null) {
        const tdElement = document.createElement('td');

        const fieldsetElement = document.createElement('fieldset');
        fieldsetElement.style.marginTop = '14px';
        fieldsetElement.style.paddingBottom = '4px';

        const legendElement = document.createElement('legend');
        const legendTextElement = document.createElement('font');
        legendTextElement.style.verticalAlign = 'inherit';
        legendTextElement.textContent = legendText;
        legendElement.appendChild(legendTextElement);

        const divElement = document.createElement('div');
        divElement.className = 'tCenter';
        divElement.innerHTML = htmlContent;

        fieldsetElement.appendChild(legendElement);
        fieldsetElement.appendChild(divElement);

        tdElement.appendChild(fieldsetElement);

        return tdElement;
    }

    function generateLoadingDiv(torrent) {
        // Create the outer div element with class "lds-ring"
        const outerDiv = document.createElement('div');
        outerDiv.classList.add('lds-ripple');

        // Create the four inner div elements
        for (let i = 0; i < 2; i++) {
            const innerDiv = document.createElement('div');
            outerDiv.appendChild(innerDiv);
        }

        // Add the created element to the document body (or any other desired parent element)
        document.body.appendChild(outerDiv);

        return outerDiv;
    }

    function generateToggle(labelText, initialValue, callback) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        const span = document.createElement("span");

        input.type = "checkbox";

        input.checked = initialValue;

        input.addEventListener("change", () => {
            callback(input.checked);
        });

        span.textContent = labelText;

        label.appendChild(input);
        label.appendChild(span);

        return label;
    }
    // ==/DOM methods==

    // ==Handler methods==
    function showFreeleechCountdown() {
        const logo = document.getElementById('logo-td');
        const leechInfoElement = document.createElement('p');
        leechInfoElement.setAttribute('id', 'freeleech-countdown');
        logo.appendChild(leechInfoElement);

        setInterval(() => {
            const leechInfoElement = document.getElementById('freeleech-countdown');
            leechInfoElement.innerText = getFreeleechInfo();
        }, 1000);

        // The text that gets shown for the next/current freeleech event.
        function getFreeleechInfo() {
            const today = new Date();
            const nextFreeleechDate = getNextFreeleechDate();
            const freeleechStart = nextFreeleechDate;
            const isFreeleechDay = isToday(nextFreeleechDate);

            // Return next freeleech date START date.
            function getNextFreeleechDate() {
                const now = new Date();
                let nextFreeleechDate = getLastSaturday(now.getFullYear(), now.getMonth(), 0);

                // If current month has already had freeleech, get next month's.
                if (nextFreeleechDate < now && !isToday(nextFreeleechDate)) {
                    nextFreeleechDate = getLastSaturday(now.getFullYear(), now.getMonth() + 1, 0);
                }

                // Simply fetches the last saturday of a given year + month.
                function getLastSaturday(year, month) {
                    const lastDayOfMonth = new Date(year, month + 1, 0);
                    const dayOfWeek = lastDayOfMonth.getDay();
                    const daysUntilLastSaturday = (dayOfWeek + 1) % 7; // Adding 1 to convert Sunday (0) to 1
                    const lastSaturdayDate = lastDayOfMonth.getDate() - daysUntilLastSaturday;
                    let timezoneOffset = TIMEZONE_OFFSET;

                    let lastSaturday = new Date(year, month, lastSaturdayDate);
                    lastSaturday.setHours(lastSaturday.getHours() - timezoneOffset);

                    return lastSaturday;
                }

                return nextFreeleechDate;
            }

            let timeUntilEvent = null;
            if (isFreeleechDay) {
                // countdown = end of current freeleech period.
                let midnightNextDay = new Date();
                midnightNextDay.setDate(midnightNextDay.getDate() + 1);
                midnightNextDay.setHours(0, 0, 0, 0);
                midnightNextDay.setHours(midnightNextDay.getHours() - TIMEZONE_OFFSET)

                timeUntilEvent = midnightNextDay - today;
            } else {
                // event = start of next freeleech period.
                timeUntilEvent = freeleechStart - today;
            }

            const daysUntilEvent = Math.floor(timeUntilEvent / (1000 * 60 * 60 * 24));
            const hoursUntilEvent = Math.floor((timeUntilEvent % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutesUntilEvent = Math.floor((timeUntilEvent % (1000 * 60 * 60)) / (1000 * 60));
            const secondsUntilEvent = Math.floor((timeUntilEvent % (1000 * 60)) / 1000);
            const timer = `(${daysUntilEvent}d ${hoursUntilEvent}h ${minutesUntilEvent}m ${secondsUntilEvent}s)`;

            if (isFreeleechDay) {
                return (`Freeleech day! Time left: ${timer}`);
            }

            return `Next freeleech event: ${timer} @ ${nextFreeleechDate}.`;
        }
    }

    function showRemainingDownloads() {
        const remainingQuota = calculateRemainingDownloadQuota();

        const logo = document.getElementById('logo-td');
        const downloadsRemainingElement = document.createElement('p');

        downloadsRemainingElement.innerText = `Downloads remaining: ${remainingQuota}`;

        logo.appendChild(downloadsRemainingElement);

        downloadsRemainingElement.style.color = 'green';
        if (remainingQuota < 10) {
            downloadsRemainingElement.style.color = 'orange';
        } else if (remainingQuota <= 0) {
            downloadsRemainingElement.style.color = 'red';
        }
    }

    function handleTrackerPage() {
        // 1. Prepare all torrent data
        const torrents = handleTorrentRows();
        // 2. add elements to UI.
        addElements(torrents);

        // Helper functions specific for tracker page.
        // TODO: might be ideal to make a more generic method from this, as it's reused partially.
        function handleTorrentRows() {
            // 1. Get all torrent rows
            const torrentRows = document.querySelectorAll('#main_content table#tor-tbl tr.tCenter');
            // 2. Handle each "type". (TODO: this method should be globally available).
            function getAllVideoRows(torrentRows) {
                // TODO: Get from preferences after preferences has been fully implemented.
                const prefVideoFormats = AVAILABLE_VIDEO_FORMATS;

                const filteredTorrentsByVideoFormatPrefs = {};
                prefVideoFormats.forEach(videoFormat => {
                    const filteredTorrentRows = Array.from(torrentRows).filter(row => row.textContent.includes(videoFormat));
                    const filteredTorrents = filterEmptyOrFalseTorrent(filteredTorrentRows.map(mapTrackerToTorrent));

                    filteredTorrentsByVideoFormatPrefs[videoFormat] = filteredTorrents;
                });

                return filteredTorrentsByVideoFormatPrefs;
            }

            function getAllPictureRows(torrentRows) {
                const pictureTopics = getPictureTopics();

                return Array.from(torrentRows).filter(row => {
                    // Topic is the 3rd column of a tracker row.
                    const topicUrl = row.querySelector('td:nth-of-type(3) a').getAttribute('href');

                    return pictureTopics.some(topicId => topicUrl.includes(`f=${topicId}`));
                }).map(mapTrackerToTorrent);
            }

            function getAllUncenRows(torrentRows) {
                const uncenFilteredTorrentRows = Array.from(torrentRows).filter(row => {
                    const lowercasedText = row.textContent.toLowerCase();
                    return lowercasedText.includes('uncen') || (!lowercasedText.includes('ptcen') && !lowercasedText.includes('cen'));
                });

                return filterEmptyOrFalseTorrent(uncenFilteredTorrentRows.map(mapTrackerToTorrent));
            }

            function getAllRows(torrentRows) {
                return filterEmptyOrFalseTorrent(Array.from(torrentRows).map(mapTrackerToTorrent));
            }

            // TODO: add "other" which contains all torrent that are not included in any group (except for 'all').
            const torrents = {
                Video: getAllVideoRows(torrentRows),
                Pictures: [...getAllPictureRows(torrentRows)],
                Uncen: [...getAllUncenRows(torrentRows)],
                All: [...getAllRows(torrentRows)]
            };

            return torrents;
        }

        function getAllTopics() {
            const topicOptions = document.querySelectorAll('select#fs-main option');
            const topics = [];
            Array.from(topicOptions).map((option) => {
                const topicId = option.getAttribute('value');
                const topicTitle = option.innerText.replace(/^\|-\s*/, '');

                const topic = new TorrentTopic(topicId, topicTitle, '#');
                topics.push(topic);
            });

            return topics;
        }

        function getPictureTopics() {
            // TODO: might be a good idea to just manually fetch the IDs?
            const allowedTopics = ["MetArt", "Picture", "Misc", "Magazines", "Photo", "Hentai: main subsection", "Manga", "Art", "HCG", "Cartoons", "Comics"];
            const topicIds = getAllTopics()
                .filter(topic => {
                    const topicToCheck = topic.title.toLowerCase();
                    return allowedTopics.some(word => topicToCheck.includes(word.toLowerCase()));
                })
                .map(topic => topic.id);

            if (topicIds.length == 0) {
                return [];
            }

            return topicIds;
        }

        function addElements(torrents) {
            // 1. Prepare everything.
            // Create the new legend with all new elements.
            const buttonsLegend = generateLegend("Torrent opener (tabs)");
            buttonsLegend.setAttribute('colspan', '3');
            const downloadButtonWrapper = document.createElement('div');
            const progressBarWrapper = document.createElement('div');

            const downloadButtons = generateArrayOfDownloadButtons(torrents);
            // Add button and progress bar to their respective wrapper.
            downloadButtons.forEach((downloadButton, index) => {
                const button = downloadButton.button;
                const progressBar = downloadButton.progressBar;
                progressBar.style.display = 'block';
                if (index > 0) {
                    button.style.marginLeft = '10px';
                    progressBar.marginTop = '10px';
                }
                // Add button to wrapper
                downloadButtonWrapper.appendChild(button);
                progressBarWrapper.appendChild(progressBar);
            });
            // Add wrappers to the buttons legend.
            buttonsLegend.querySelector('div').appendChild(downloadButtonWrapper);
            buttonsLegend.querySelector('div').appendChild(progressBarWrapper);

            // 2. Add to the UI.
            // Get location and add the element legend there.
            const searchTableBody = document.querySelector("#tr-form > table > tbody > tr:nth-child(2) > td > table > tbody");
            const elementsRow = document.createElement('tr');
            elementsRow.appendChild(buttonsLegend);
            searchTableBody.appendChild(elementsRow);
        }
    }

    function handleProfilePage() {
        addElements();
        updateProfileWithProfilePageData();

        function addElements() {
            addTorrentsTable();
            showRatioPredictions();
            showRemainingDownloads();

            function addTorrentsTable() {
                const contentWrap = document.querySelector('#main_content_wrap');
                const downloadedTorrentsTable = generateTorrentsTable(getAllDownloadedTorrents());
                // Prepare the downloaded Torrents element + add to view.
                const downloadedTorrentsWrapper = document.createElement('div');
                downloadedTorrentsWrapper.classList.add('active-torrents-list');
                downloadedTorrentsWrapper.innerHTML = '<div class="table-title">Already downloaded torrents.</div>';
                downloadedTorrentsWrapper.appendChild(downloadedTorrentsTable);
                contentWrap.appendChild(downloadedTorrentsWrapper);
            }

            // Calculate uer stats with data from user profile page.
            function showRatioPredictions() {
                const userRatio = document.getElementById('u_ratio');
                const ratioPredictionTr = document.createElement('tr');

                const predictedRatio = predictRatio();
                const nextRatio = calculateNearestRatio(predictedRatio);
                const stats = getTorrentStatsFromProfilePage();
                const nextRatioDept = formatBytes(calculateRequiredUploadRatio(stats.totalDown, stats.totalUp, nextRatio));

                ratioPredictionTr.innerText = `Ratio after reset: ${predictedRatio}.
                Next ratio: ${nextRatio} (${nextRatioDept} upload to go).
                Next server reset ${calculateTimeUntilServerReset()}`
                userRatio.appendChild(ratioPredictionTr);
                setInterval(updateTimer, 1000);
                function updateTimer() {
                    ratioPredictionTr.innerText = `Ratio after reset: ${predictedRatio}.
                Next ratio: ${nextRatio} (${nextRatioDept} upload to go).
                Next server reset ${calculateTimeUntilServerReset()}`
                }
            }

            // TODO: move parts of this to a generic one, so it can be reused on other pages.
            function showRemainingDownloads() {
                const userTable = document.querySelector("#main_content_wrap > table > tbody > tr:nth-child(2) > td:nth-child(2) > table > tbody");
                const downloadStatsRow = document.createElement('tr');

                const downloadStatsHeader = document.createElement('th');
                downloadStatsHeader.innerText = 'Downloads left today:'

                const downloadsRemainingData = document.createElement('td');
                const downloadsRemaining = calculateRemainingDownloadQuota();
                const quotaPercentage = Math.floor((1 - downloadsRemaining / getDownloadQuotaForProfile()) * 100);
                const progressBar = generateProgressBar(quotaPercentage, 'downloads-quota-left', `${downloadsRemaining} left.`)
                downloadsRemainingData.appendChild(progressBar);

                downloadStatsRow.appendChild(downloadStatsHeader);
                downloadStatsRow.appendChild(downloadsRemainingData);

                userTable.appendChild(downloadStatsRow);
            }
        }

        // Handler specific helper methods
        function getTorrentStatsFromProfilePage() {
            var sizeRegex = /^([\d.,]+)\s*([a-zA-Z]+)/;

            // Help class to easily fetch the data we care about.
            function getSizeValue(element) {
                const content = element?.textContent.match(sizeRegex);
                if (content) {
                    const bytes = convertSizeBetweenUnits(content[1], content[2], 'B');
                    return bytes;
                }
                return 0;
            }

            const rows = document.querySelectorAll('.ratio tr');
            const elements = [
                { index: 1 },
                { index: 2, id: '#u_up_total' },
                { index: 3, id: '#u_up_release' },
                { index: 4, id: '#u_up_bonus' }
            ];

            let totalDown = 0;
            let totalUp = 0;
            let totalRelease = 0;
            let totalBonus = 0;

            for (const element of elements) {
                const row = rows[element.index];
                const updateValue = getSizeValue(row.querySelector('td:nth-of-type(1)'), element.index);
                const todayValue = getSizeValue(row.querySelector('td:nth-of-type(2)'), element.index);
                const totalValue = getSizeValue(row.querySelector('td:nth-of-type(4)'), element.index);

                switch (element.index) {
                    case 1:
                        totalDown = updateValue + todayValue + totalValue;
                        break;
                    case 2:
                        totalUp = updateValue + todayValue + totalValue;
                        break;
                    case 3:
                        totalRelease = updateValue + todayValue + totalValue;
                        break;
                    case 4:
                        totalBonus = updateValue + todayValue + totalValue;
                        break
                    default:
                        console.debug('Unmapped index found.');
                }
            }

            return {
                'totalUp': totalUp,
                'totalRelease': totalRelease,
                'totalBonus': totalBonus,
                'totalDown': totalDown,
            };
        }

        function updateProfileWithProfilePageData() {
            // Get current profile to update with page data.
            const profile = getProfile();
            const torrentStats = getTorrentStatsFromProfilePage();

            profile.ratio = {
                ratio: document.querySelector('#u_ratio > b').innerText.trim(),
                downloaded: torrentStats.totalDown,
                uploaded: torrentStats.totalUp,
                lastUpdated: Date()
            }

            updateProfile(profile);
        }

        function predictRatio() {
            // TODO: get stats: but not from profile page, save it in preferences.
            const stats = getTorrentStatsFromProfilePage();
            const rating = stats.totalDown !== 0 ? (stats.totalUp + stats.totalRelease + stats.totalBonus) / stats.totalDown : 0;

            return Math.floor(rating * 100) / 100;
        }
    }

    function handleTorrentPage() {
        registerEventListeners();

        function registerEventListeners() {
            const downloadTorrentBtn = document.querySelector('#tor-reged .dl-stub.dl-link');
            const torrentId = location.search.substr(3);
            const torrentTitle = document.querySelector('h1.maintitle').innerText.trim();
            const torrentUrl = location.href;
            const torrentSize = document.querySelector('#main_content_wrap .dl_list tbody tr:nth-of-type(2) td b:nth-of-type(1)').innerText;

            const topicElement = document.querySelector("#main_content_wrap > table:nth-child(4) > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td.nav > a:nth-child(5)");
            const topicUrl = topicElement.href;
            const topicId = getIdFromUrl(topicUrl, 'topic');
            const topicTitle = topicElement.innerText;
            const torrentTopic = new TorrentTopic(topicId, topicTitle, topicUrl);
            const torrent = new Torrent(torrentId, torrentTitle, torrentUrl, torrentSize, torrentTopic);

            document.querySelector('#page_container').style.backgroundColor = isTorrentAlreadyDownloaded(torrentId) ? 'red' : 'green';

            downloadTorrentBtn.addEventListener('click', (event) => {
                hanldeDownloadTorrent(event, torrent);
            });
        }

        function hanldeDownloadTorrent(event, torrent) {
            const downloadedTorrents = getAllDownloadedTorrents();
            if (isTorrentAlreadyDownloaded(torrent.id)) {
                const response = confirm("Torrent has been marked as downloaded. Redownload?");
                if (!response) {
                    event.preventDefault();

                    return;
                }
            }

            // Add torrent to profile.
            torrent.downloadDate = new Date().toJSON()
            downloadedTorrents.push(torrent);
            const profile = getProfile();
            profile.downloadedTorrents = downloadedTorrents
            updateProfile(profile);
        }
    }

    function updateProgressBar(id, percentage) {
        const progressBarWrapper = document.getElementById(id);
        const progressBar = progressBarWrapper.querySelector('.progress-bar')

        if (progressBarWrapper && progressBar) {
            progressBarWrapper.style.display = 'block';
            progressBar.style.width = `${percentage}%`;
            progressBar.querySelector('span.progress-bar-value').textContent = `${percentage}%`;
        }
    }

    function handleFormPage() {
        // 1. Get torrents from page.
        const torrents = handleTorrentRows();
        // 2. Add elements to UI.
        addElements(torrents);

        // TODO: might be ideal to make a more generic method from this, as it's reused partially.
        function handleTorrentRows() {
            // 1. Get all torrent rows
            const torrentRows = document.querySelectorAll('#main_content table.forum tr[id]');
            // 2. Handle each "type".
            function getAllVideoRows(torrentRows) {
                // TODO: Get from preferences after preferences has been fully implemented.
                const prefVideoFormats = AVAILABLE_VIDEO_FORMATS;

                const filteredTorrentsByVideoFormatPrefs = {};
                prefVideoFormats.forEach(videoFormat => {
                    const filteredTorrentRows = Array.from(torrentRows).filter(row => row.textContent.includes(videoFormat));
                    const filteredTorrents = filterEmptyOrFalseTorrent(filteredTorrentRows.map(mapFormPostToTorrent));

                    filteredTorrentsByVideoFormatPrefs[videoFormat] = filteredTorrents;
                });

                return filteredTorrentsByVideoFormatPrefs;
            }

            function getAllUncenRows(torrentRows) {
                const uncenFilteredTorrentRows = Array.from(torrentRows).filter(row => {
                    const lowercasedText = row.textContent.toLowerCase();
                    return lowercasedText.includes('uncen') || (!lowercasedText.includes('ptcen') && !lowercasedText.includes('cen'));
                });

                return filterEmptyOrFalseTorrent(uncenFilteredTorrentRows.map(mapFormPostToTorrent));
            }

            function getAllRows(torrentRows) {
                return filterEmptyOrFalseTorrent(Array.from(torrentRows).map(mapFormPostToTorrent));
            }

            // TODO: add "other" which contains all torrent that are not included in any group (except for 'all').
            return {
                Video: getAllVideoRows(torrentRows),
                Uncen: [...getAllUncenRows(torrentRows)],
                All: [...getAllRows(torrentRows)]
            };
        }

        function addElements(torrents) {
            // 1. Prepare everything.
            // Create the new legend with all new elements.
            const buttonsLegend = generateLegend("Torrent opener (tabs)");
            buttonsLegend.setAttribute('colspan', '3');
            const downloadButtonWrapper = document.createElement('div');
            const progressBarWrapper = document.createElement('div');

            const downloadButtons = generateArrayOfDownloadButtons(torrents);
            // Add button and progress bar to their respective wrapper.
            downloadButtons.forEach((downloadButton, index) => {
                const button = downloadButton.button;
                const progressBar = downloadButton.progressBar;
                progressBar.style.display = 'none';
                if (index > 0) {
                    button.style.marginLeft = '10px';
                    progressBar.marginTop = '10px';
                }
                // Add button to wrapper
                downloadButtonWrapper.appendChild(button);
                progressBarWrapper.appendChild(progressBar);
            });
            // Add wrappers to the buttons legend.
            buttonsLegend.querySelector('div').appendChild(downloadButtonWrapper);
            buttonsLegend.querySelector('div').appendChild(progressBarWrapper);

            // 2. Add to the UI.
            // Get location and add the element legend there.
            const searchTableBody = document.querySelector("#main_content_wrap > table:nth-child(6) > tbody")
            const elementsRow = document.createElement('tr');
            elementsRow.appendChild(buttonsLegend);
            searchTableBody.appendChild(elementsRow);
        }
    }
    // ==/Handler methods==

    // ==Main==
    function initializeScript() {
        // Initialize the profile (if no profile has been set yet.) - This should only happen once.
        if (!getProfile()) {
            console.debug("No profile is found. Assuming first run. Creating new profile.");
            const profile = new Profile();
            updateProfile(profile);
        } else {
            let timeUntilNextReset = calculateTimeUntilServerReset(true);

            // Server reset interval (24 hours)
            const resetIntervalSeconds = 24 * 60 * 60;

            // Convert time until next reset to total seconds.
            let secondsUntilNextReset =
                (timeUntilNextReset.hours * 3600) +
                (timeUntilNextReset.minutes * 60) +
                timeUntilNextReset.seconds;

            let lastResetTimeInSeconds = Math.floor(new Date().getTime() / 1000) - secondsUntilNextReset;

            // Function to check if a given date is after the last reset
            function isAfterLastReset(givenDate) {
                // Convert the given date to seconds since the epoch
                let givenDateInSeconds = Math.floor(givenDate.getTime() / 1000);
                return givenDateInSeconds > lastResetTimeInSeconds;
            }

            // When ratio data is too old, we need to update it.
            if (!isAfterLastReset(new Date(getProfile()?.ratio.lastUpdated))) {
                const profileLink = document.querySelector("#page_header > div.topmenu > table > tbody > tr > td:nth-child(1) > a:nth-child(1)").href;
                window.location.href = profileLink;
            }
        }

        // Page specific script loading.
        if (checkPage('profile_page')) {
            handleProfilePage();
        }

        if (checkPage('topic_page')) {
            handleTorrentPage();
        }

        if (checkPage('form_page')) {
            handleFormPage();
        }

        if (checkPage('tracker_page')) {
            handleTrackerPage();
        }
        // Methods for all pages after this.
        showFreeleechCountdown();
        showRemainingDownloads();
    }
    // ==/Main==

    initializeScript();
})();