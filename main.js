const electron = require('electron');
const { app, BrowserWindow } = electron;
const ipc = electron.ipcMain;
// const jetpack = require("fs-jetpack");
const fetch = require("node-fetch");
const os = require("os");
const isReachable = require('is-reachable');
const download = require('image-downloader'); // Used for both images and videos
const md5File = require('md5-file');
const getSize = require('get-folder-size');
const fs = require('fs');
const url = require('url');
const fse = require('fs-extra')
const log = require('electron-log');
const schedule = require('node-schedule');
const path = require('path');
const isDev = require('electron-is-dev');
const EventEmitter = require('events');
const {exec} = require('child_process');
// const URI = (electron.app || electron.remote.app).getPath('userData');
// console.log('App storage',path.join(__dirname))

// URLs to match and intercept
const urlFilter = {
    urls: [
        '*://sa.ds-app.com/*.png',
        '*://sa.ds-app.com/*.jpg',
        '*://sa.ds-app.com/*.mp4'
    ]
};

// Server appBaseUrl
global.appBaseUrl = "https://sa.ds-app.com";
// Main data directory
// global.appDataDir = "/home/demo/electron/resources/app/ds_data";
global.appDataDir = getAppDataPath(path.join(__dirname,'ds_data'));
// Media directory, inside appDataDir
global.appMediaDir = getAppDataPath(path.join(global.appDataDir, "media"));
// Playlist Status appModifiedOn timestamp value
global.appModifiedOn = 0;
// SlideShowJson
global.appSlideShowJson = null;

// File to write logs
global.appLogFile = path.join(__dirname,'activity.log');
log.transports.file.resolvePath = () => global.appLogFile;

// Global variables
let win;
let playlist_update_checker;
let slide_cache = path.join(__dirname,'cached_slideshow.site/index.html')
let previous_internet_status = 'online';

// Event emitter object for triggering and handling event in main process
const globalEvents = new EventEmitter();

// Overriding error, warn etc.
Object.assign(console, log.functions);

// Get file path of create it if it does not exist
function getAppDataPath(path){
    try {
        if (fs.existsSync(path)) {
            return path
        } else {
            fs.mkdirSync(path)
            return path
        }
    } catch(e) {
        console.log("An error occurred.")
    }
}

// Called from whenReady function below
const createWindow = () => {
    // const {width, height} = electron.screen.getPrimaryDisplay().workAreaSize
    const {width, height} = {width: 1920, height: 1080};
    win = new BrowserWindow({
        ...(isDev ? {
            width, height
        } : {
            alwaysOnTop: true,
            fullscreen: true,
            kiosk: true,
        }),
        
        title: "Display Science",
        roundedCorners: false,
        spellcheck: false,
        webPreferences: {
            webSecurity: false,
            backgroundThrottling: false,
            nodeIntegration:false,
            contextIsolation:true,
            preload: path.join(__dirname, "preload.js"),
        }
    })
    // Loading page.
    runSlidesFromCache(slide_cache)

    // main()
}

// Main app logic
function main(){
    let ses = win.webContents.session;
   
    ses.webRequest.onBeforeRequest(urlFilter, (details, callback) => {
        let filename = path.basename(details.url);
        let fullLocalPath = path.join(global.appMediaDir, filename);
        let re;
        let pth;
        try{
            re = fs.readFileSync(fullLocalPath);
            pth = url.pathToFileURL(fullLocalPath)
        } catch(err){
            console.log("onBeforeRequest Error:",err);
        }
        
        callback({
            redirectURL: pth
        });
    });
       
    // Using immediately executed async function
    (async () => {
        // Check if server is reachable by getting playlist status.
        let urlReachable = await isReachable(global.appBaseUrl);
        // console.log('Reachable?',urlReachable)
        while (urlReachable === false){
            // Emit an offline signal whenever BaseUrl is unreachable
            // This will trigger loading slides from cache
            globalEvents.emit('offline')

            urlReachable = await isReachable(global.appBaseUrl);
        }
        // Now the server is reachable for sure.
        
        // get modified on value of the playlist
        global.appModifiedOn = await getPlaylistStatusInt();
        
        global.appSlideShowJson = await getSlideShowJson();
        
        // Download media files if they don't exist.
        await downloadMedia();
        // Load slideshow.
        win.loadURL(global.appBaseUrl+"/panels/slideShowFullScreen/"+getDeviceName()).then( (cb) => {
            const url = win.webContents.getURL()
            
            // Save slides from server to cache
            saveSlideShowToCache(url)
        })
    })();

    // Check for playlist update and relaunch app.
    // playlist_update_checker = setInterval(function (){
    //     (async () => {
    //         let modifiedOn = await getPlaylistStatusInt();
    //         if (global.appModifiedOn != modifiedOn){
    //             globalEvents.emit('reload')
    //             globalEvents.emit('offline')
    //         }
    //     })();
    // }, 10000);

    // Restart app every hour + 1 min
    const job = schedule.scheduleJob('1 * * * *', function (){
        console.log("Relaunching app at 1 min past the hour.");

        // Emit a global reload signal.
        // This will trigger reload of the main function
        globalEvents.emit('reload')
    });
}

async function loadUpdatedMedia(){
    // get modified on value of the playlist
    global.appModifiedOn = await getPlaylistStatusInt();
    
    global.appSlideShowJson = await getSlideShowJson();
    
    // Download media files if they don't exist.
    try {
        await downloadMedia();
    } catch (error) {
        console.log('Failed to fetch slide show JSON')
    }

    // Save to cache
    saveSlideShowToCache(global.appBaseUrl+"/panels/slideShowFullScreen/"+getDeviceName());
}

// Entry point. Runs when Electron is ready.
app.whenReady().then( () => {
    createWindow() // This calls the function defined above.
})

// This handles the offline global event.
// It is triggered whenever internet connection is lost or when baseUrl is unreachable.
// globalEvents.on('offline', ()=>{
//     // Load slides from cache
//     let cache = path.join(__dirname,'cached_slideshow.site/index.html')
//     // This check is to avoid running the runSlidesFromCache function multiple times
//     // It will only run once when connection changes from online to offline
//     // If connection is already offline, there isno need to reload slides
//     if(previous_internet_status === 'online'){
//         // Run downloaded slides
//         runSlidesFromCache(cache)

//         // previous_internet_status flag set to offline to prevent this block from repeating
//         previous_internet_status = 'offline'
//     }
// })

globalEvents.on('cache_saved',()=>{
    if(win.webContents.getURL() !== url.pathToFileURL(slide_cache).href){
        console.log('loading slides')
        runSlidesFromCache(slide_cache)
    }
})

// This handles the reload global event.
// Only the main function is ran on reload. BrowserWindow is not recreated
// globalEvents.on('reload',()=>{
//     main()
// })

// This handles internet status event through the preload.js script
// Through IPC (Inter-process Communication), preload.js can send internet status from the frontend
// This allows the app to detect internet status at anytime
ipc.on('online_status',(event,value)=>{
    if(value==='online'){
        console.log('online')
        playlist_update_checker = setInterval(function (){
            (async () => {
                let modifiedOn = await getPlaylistStatusInt();
                if (global.appModifiedOn != modifiedOn){
                    console.log('re-download')
                    loadUpdatedMedia()
                }else{
                    console.log('update not triggered', global.appModifiedOn, modifiedOn)
                }
            })();
        }, 10000);
    }else{
        console.log('offline')
        if(win.webContents.getURL() !== url.pathToFileURL(slide_cache).href){
            // Status: offline
            // Not loading slide show from cache
            runSlidesFromCache(slide_cache)
        }else{
            console.log('Offline and slides loaded from cache')
        }
    }
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

// On MacOS, it is common to recreate the main browser window on icon click when all windows ae closed
// This event handles that
app.on('activate', function(){
    if(BrowserWindow.getAllWindows().length === 0) createWindow()
})

/**
 * **Linux**: Check if __~/device_name.txt__ exists.
 *  If yes, use its content as device name.
 *  If not use __hostname__ as device name.
 * **Mac**: Check if __ds_data/device_name.txt__ exists
 *  If yes, use its content as device name.
 *  If not, use __sa0000__ as device name.
 */

function getDeviceName(){
    const src = path.join(__dirname,'device_name.txt')
    if(fs.existsSync(src)){
        // read file
        const deviceName = fs.readFileSync(src, {encoding:'utf8', flag:'r'});
        return deviceName
    }
    return process.platform !== 'darwin' ? os.hostname() : '__sa0000__'
}

/**
 * Get slideShowJson from server using deviceName
 * @returns  JSON
 */
async function getSlideShowJson () {
    let url = global.appBaseUrl+"/panels/slideShowJson/"+getDeviceName()
    
    try {
        const result = await fetch(url)
        const res_json = await result.json()
        return res_json
    } catch (error) {
        console.log("Failed to fetch slide show. Maybe due to failed internet connection")
    }
}

/**
 * Get current appModifiedOn timestamp and return it.
 * If failed to get, handle error but don't stop the app.
 */
async function getPlaylistStatusInt () {
    let url = global.appBaseUrl+"/panels/getPlaylistStatus/"+getDeviceName()
    
    try {
        const result = await fetch(url)
        const res_json = await result.json()
        return res_json.modifiedOn
    } catch (error) {
        console.log("Failed to fetch playlist status. Maybe due to failed internet connection")
    }
}

/**
 * Get JSON string from URL, convert to JSON obj and return it.
 * @param url
 * @returns JSON obj
 */

// async function getJson (url){
//     let response;
//     let jsonData;
//     await fetch(url)
//         .then( (resp) => {
//             console.log('res:',resp)
//             response = resp;
//         })
//         .catch( (err) => {
//             console.log('error::',err)
//             // Error getting json from url.
//             // Restart app?
//             console.log("Error in getJson (fetch) function. Restarting app.");
//             app.relaunch();
//             app.exit();
//         });

//     await response?.json()
//         .then( (data) => {
//             jsonData = data;
//         })
//         .catch( (err) => {
//             // Error getting json from url.
//             // Restart app?
//             console.log("Error in getJson (response.json) function. Restarting app.");
//             app.relaunch();
//             app.exit();
//         });
//     return jsonData;
// }

/**
 * Parse global.slideShowJson and download all media files to ds_data/media.
 */
async function downloadMedia () {
    // @TODO: check for total directory size. Should be under 10GB
    await getSize(global.appMediaDir, (err, size) => {
        // console.log("directory size:", size/1024/1024/1024)
        if (err){
            console.log("Error finding directory size: ");
        }
        if ((size/1024/1024/1024) > 10){
            fse.emptyDirSync(global.appMediaDir + "/");
            console.log("Emptying media directory");
        }
    });
    
    let ads = global.appSlideShowJson.group.playlist.advertisements;
    const imagesBaseUrl = global.appBaseUrl+"/webroot/files/Advertisements/images";
    for (let i in ads) {
        firstImage = ads[i]['first_image'];
        secondImage = ads[i]['second_image'];

        firstImageMd5 = ads[i]['first_image_md5'];
        secondImageMd5 = ads[i]['second_image_md5'];

        dlFirstImage = false; // Switch to true if md5 doesn't match
        dlSecondImage = false; // Switch to true if md5 doesnt' match
        
        // Download first image and second image
        let optionsFirstImage = {
            url: imagesBaseUrl+"/"+firstImage,
            dest: global.appMediaDir
        };
        let optionsSecondImage = {
            url: imagesBaseUrl+"/"+secondImage,
            dest: global.appMediaDir
        };
        await md5File(global.appMediaDir + "/" + firstImage)
            .then( (md5) => {
                if (md5 !== firstImageMd5){
                    console.log("MD5 mismatch. Downloading file.");
                    console.log("MD5 on disk: " + md5 + " MD5 from server: " + firstImageMd5 + " URL: " + firstImage);
                    dlFirstImage = true;
                }
            })
            .catch( (err) => {
                console.log("File not on disk. Downloading file. " + err);
                dlFirstImage = true;
            });
        await md5File(global.appMediaDir + "/" + secondImage)
            .then( (md5) => {
                if (md5 !== secondImageMd5){
                    console.log("MD5 mismatch. Downloading file.");
                    console.log("MD5 on disk: " + md5 + " MD5 from server: " + secondImageMd5 + " URL: " + secondImage);
                    dlSecondImage = true;
                }
            })
            .catch( (err) => {
                console.log("File not on disk. Downloading file. " + err);
                dlSecondImage = true;
            });
        if (dlFirstImage){
            await download.image(optionsFirstImage)
                .then(({ filename }) => {
                    console.log('Saved to', filename); // saved to /path/to/dest/image.jpg
                })
                .catch((err) => {
                    console.log('first image download error:')
                    console.error(err)
                });
        }
        if (dlSecondImage){
            await download.image(optionsSecondImage)
                .then(({ filename }) => {
                    console.log('Saved to', filename); // saved to /path/to/dest/image.jpg
                })
                .catch((err) => {
                    console.log('second image download error:')
                    console.error(err)
                });
        }
        
        // Retry download if md5 doesn't match?
        // while(md5File.sync(app.getAppPath() + "/" + global.appMediaDir + "/" + firstImage) != firstImageMd5){
        //     await download.image(optionsFirstImage);
        // }
        
        // console.log(md5File.sync(app.getAppPath() + "/" + global.appMediaDir + "/" + firstImage));
    }
}

function saveSlideShowToCache(url){
    // Download slide show from url
    // exec function allows us to execute command terminal commands
    // With the help of node-site-manager, we download source files of the url 
    exec(`node-site-downloader download -s ${url} -d ${url} -v --include-images -o cached_slideshow`,(err,stdout,stderr)=>{
        // Downloaded source files will be in a folder called cached_slideshow.site
        const cache_dir = path.join(__dirname,'cached_slideshow.site')
        
        // Replace the media url in the index.html of the downloaded source files
        // First read all files in the global.appMediaDir
        fs.readdir(global.appMediaDir, (error, files) => {
            if (error) console.log(error)
            // Filter files and get only mp4 files into video_files array
            let video_files = []
            files.forEach( file => {
                if(path.extname(file)==='.mp4'){
                    video_files.push(file)
                }
            })
            
            // Read the index.html and get the HTML content as data
            fs.readFile(path.join(cache_dir,'index.html'),'utf8', (err,data)=>{
                // console.log('cache folder:',path.join(cache_dir,'index.html'))
                if(err){
                    console.log(err)
                }
                
                // Use regex to match video tags with src attribute
                const videoTags = data.match(/<video [^>]*src="[^"]*"[^>]*>/gm)
                
                // Loop through all matches and replace the src attribute with the url of downloaded files in global.appMediaDir
                let newHTML = data
                videoTags?.forEach((tag,i)=>{
                    let newTag = tag.replace(/src="([^"]*)".*/, `src=${path.join(global.appMediaDir,video_files[i])}>`)
                    newHTML = newHTML.replace(tag,newTag)
                })
                
                // Rewrite new HTML into the index.html
                fs.writeFile(path.join(cache_dir,'index.html'),newHTML,(err)=>{
                    if(err){
                        console.log('Failed to rewrite index.html')
                    }else{
                        console.log('Slides saved successfully')
                        globalEvents.emit('cache_saved')
                    }
                })
            })
        })
    })
}

// Checks if cache exists
// If exists, load page from cache
function runSlidesFromCache(cache){
    if(fs.existsSync(cache)){
        win.loadFile(cache)
    }else if(win.webContents.getURL() !== url.pathToFileURL(path.join(__dirname, 'loading.html')).href){
        win.loadFile(path.join(__dirname, 'loading.html'));
    }
}
